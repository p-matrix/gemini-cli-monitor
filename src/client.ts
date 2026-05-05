// =============================================================================
// @pmatrix/gemini-cli-monitor — client.ts
// PMatrixHttpClient: POST /v1/inspect/stream, GET /v1/agents/{id}/public
// 95% reuse from @pmatrix/cursor-monitor — signal_source + framework changed
// signal_source: 'gemini_cli_hook', framework: 'gemini_cli'
//
// v0.4.0 cross-cutting client 보강 (server Production Polish 정합):
//   A. Error correlation logging — 5xx body.error.error_id / X-Error-ID
//      → stderr 안내 ("Support 문의 시 Error ID 함께 제공")
//   B. X-Request-ID — outgoing crypto.randomUUID() 송출 +
//      response echo trace (PMATRIX_DEBUG_TRACE)
//   C. Burst 429 handling — Retry-After 우선, 없으면 escalating backoff
//      (BURST_RETRY_DELAYS [1000, 5000, 30000])
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  PMatrixConfig,
  SignalPayload,
  GradeResponse,
  AgentGradeDetail,
  BatchSendResponse,
  AxesState,
  SafetyMode,
  TrustGrade,
} from './types';

// ─── Runtime shape guards ─────────────────────────────────────────────────────
// Defensive checks that detect payload schema drift at runtime.
// Throws if response is malformed; monitor's caller treats as network failure.

function assertGradeResponseShape(raw: unknown): asserts raw is GradeResponse {
  if (!raw || typeof raw !== 'object') {
    throw new Error('PMatrix API: GradeResponse payload not an object');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.agent_id !== 'string' || typeof r.grade !== 'string' || !r.axes) {
    throw new Error('PMatrix API: GradeResponse missing required fields (agent_id/grade/axes)');
  }
}

function assertAgentGradeDetailShape(raw: unknown): asserts raw is AgentGradeDetail {
  if (!raw || typeof raw !== 'object') {
    throw new Error('PMatrix API: AgentGradeDetail payload not an object');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.history)) {
    throw new Error('PMatrix API: AgentGradeDetail.history missing or not an array');
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RETRY_DELAYS = [100, 500, 2_000] as const;
/**
 * Burst 429 escalating backoff (server burst_rate_limit middleware 정합).
 * Used only when status === 429 and Retry-After header is absent.
 */
const BURST_RETRY_DELAYS = [1_000, 5_000, 30_000] as const;
const REQUEST_TIMEOUT_MS = 10_000;

const RESUBMIT_INTERVAL_MS = 60_000;
const MAX_RESUBMIT_FILES   = 5;
const MAX_UNSENT_AGE_MS    = 7 * 24 * 60 * 60 * 1_000;

// ─── Response interfaces ──────────────────────────────────────────────────────

export interface HealthCheckResult {
  healthy: boolean;
  grade?: GradeResponse;
}

export interface SessionSummaryInput {
  sessionId: string;
  agentId: string;
  totalTurns: number;
  dangerEvents: number;
  credentialBlocks: number;
  safetyGateBlocks: number;
  endReason?: string;
  signal_source: 'gemini_cli_hook';
  framework: 'gemini_cli';
  framework_tag: 'beta' | 'stable';
}

// ─── PMatrixHttpClient ────────────────────────────────────────────────────────

export class PMatrixHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly agentId: string;
  private readonly retryMax: number;
  private readonly debug: boolean;
  private readonly localUrl: string | null;
  private lastResubmitAt: number = 0;

  constructor(config: PMatrixConfig) {
    this.baseUrl = config.serverUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.agentId = config.agentId;
    this.retryMax = config.batch.retryMax;
    this.debug = config.debug;
    this.localUrl = (config as any).localUrl ?? process.env.PMATRIX_LOCAL_URL ?? null;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.agentId) {
      return { healthy: false };
    }
    try {
      const grade = await this.getAgentGrade(this.agentId);
      return { healthy: true, grade };
    } catch {
      return { healthy: false };
    }
  }

  async getAgentGrade(agentId: string): Promise<GradeResponse> {
    const url = `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/public`;
    const raw = await this.fetchWithRetry('GET', url, null);
    assertGradeResponseShape(raw);
    return raw as GradeResponse;
  }

  async getAgentGradeDetail(agentId: string): Promise<AgentGradeDetail> {
    const url = `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/grade`;
    const raw = await this.fetchWithRetry('GET', url, null);
    assertAgentGradeDetailShape(raw);
    return raw as AgentGradeDetail;
  }

  async sendBatch(signals: SignalPayload[]): Promise<BatchSendResponse> {
    if (signals.length === 0) return { received: 0 };
    // Defense-in-depth: all-zero axes → R(t)=0.75 → instant HALT.
    // Correct to neutral (0.5) before transmission. [LL-1]
    for (const s of signals) {
      if (s.baseline === 0 && s.norm === 0 && s.stability === 0 && s.meta_control === 0) {
        s.baseline = 0.5;
        s.norm = 0.5;
        s.stability = 0.5;
        s.meta_control = 0.5;
      }
    }
    try {
      return await this.sendBatchDirect(signals);
    } catch (err) {
      await this.backupToLocal(signals);
      throw err;
    }
  }

  async sendSignal(signal: SignalPayload): Promise<BatchSendResponse> {
    return this.sendBatch([signal]);
  }

  async resubmitUnsent(): Promise<void> {
    const now = Date.now();
    if (now - this.lastResubmitAt < RESUBMIT_INTERVAL_MS) return;
    this.lastResubmitAt = now;

    const dir = path.join(os.homedir(), '.pmatrix', 'unsent');
    let files: string[];
    try {
      files = (await fs.promises.readdir(dir))
        .filter(f => f.endsWith('.json'))
        .sort()
        .slice(0, MAX_RESUBMIT_FILES);
    } catch {
      return;
    }

    for (const filename of files) {
      const filepath = path.join(dir, filename);
      try {
        const stat = await fs.promises.stat(filepath);
        if (now - stat.mtimeMs > MAX_UNSENT_AGE_MS) {
          await fs.promises.unlink(filepath);
          continue;
        }
        const raw = await fs.promises.readFile(filepath, 'utf-8');
        const signals = JSON.parse(raw) as SignalPayload[];
        await this.sendBatchDirect(signals);
        await fs.promises.unlink(filepath);
      } catch (err) {
        if (err instanceof SyntaxError) {
          await fs.promises.unlink(filepath).catch(() => {});
        }
      }
    }
  }

  async sendCritical(signal: SignalPayload): Promise<void> {
    const url = `${this.baseUrl}/v1/inspect/stream`;
    try {
      await this.fetchOnce('POST', url, signal);
    } catch {
      await this.backupToLocal([signal]);
    }
  }

  /**
   * Session summary — sent on sessionEnd
   * signal_source: 'gemini_cli_hook', framework: 'gemini_cli'
   */
  async sendSessionSummary(data: SessionSummaryInput): Promise<void> {
    const url = `${this.baseUrl}/v1/inspect/stream`;
    const payload: SignalPayload = {
      agent_id: data.agentId,
      // neutral axes — avoids all-zero → R(t)=0.75 grade pollution
      baseline: 0.5,
      norm: 0.5,
      stability: 0.5,
      meta_control: 0.5,
      timestamp: new Date().toISOString(),
      signal_source: 'gemini_cli_hook',
      framework: 'gemini_cli',
      framework_tag: data.framework_tag,
      schema_version: '0.3',
      metadata: {
        event_type: 'session_summary',
        session_id: data.sessionId,
        total_turns: data.totalTurns,
        danger_events: data.dangerEvents,
        credential_blocks: data.credentialBlocks,
        safety_gate_blocks: data.safetyGateBlocks,
        end_reason: data.endReason,
        priority: 'normal',
      },
      state_vector: null,
    };

    try {
      await this.fetchWithRetry('POST', url, payload);
    } catch {
      await this.backupToLocal([payload]);
    }
  }

  static extractRtFromResponse(res: BatchSendResponse): {
    rt: number;
    mode: SafetyMode;
    grade: TrustGrade;
    axes: AxesState;
  } | null {
    if (
      res.risk == null ||
      res.grade == null ||
      res.mode == null ||
      res.axes == null
    ) {
      return null;
    }
    return {
      rt: res.risk,
      mode: res.mode,
      grade: res.grade,
      axes: {
        baseline: res.axes.baseline,
        norm: res.axes.norm,
        stability: res.axes.stability,
        meta_control: res.axes.meta_control,
      },
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async sendBatchDirect(signals: SignalPayload[]): Promise<BatchSendResponse> {
    const body = signals.length === 1 ? signals[0] : signals;

    // Try local sidecar first (if available)
    if (this.localUrl) {
      try {
        const localEndpoint = `${this.localUrl}/v1/inspect/local`;
        const raw = await this.fetchOnce('POST', localEndpoint, body);
        if (this.debug) {
          process.stderr.write(`[P-MATRIX] Local sidecar response received\n`);
        }
        return (raw as BatchSendResponse | null) ?? { received: signals.length };
      } catch {
        // Local sidecar unavailable — fall through to server
        if (this.debug) {
          process.stderr.write(`[P-MATRIX] Local sidecar unavailable, falling back to server\n`);
        }
      }
    }

    // Server path (with retries)
    const url = `${this.baseUrl}/v1/inspect/stream`;
    const raw = await this.fetchWithRetry('POST', url, body);
    return (raw as BatchSendResponse | null) ?? { received: signals.length };
  }

  private async fetchWithRetry(
    method: string,
    url: string,
    body: unknown
  ): Promise<unknown> {
    let lastError: BurstRetryError | Error = new Error('Unknown error');

    for (let attempt = 0; attempt <= this.retryMax; attempt++) {
      try {
        return await this.fetchOnce(method, url, body);
      } catch (err) {
        lastError = err as Error;
        if (attempt < this.retryMax) {
          // Cross-cutting C — 429 escalating backoff. Retry-After 우선.
          let delay: number;
          if (err instanceof BurstRetryError) {
            delay =
              err.retryAfterMs ??
              BURST_RETRY_DELAYS[Math.min(attempt, BURST_RETRY_DELAYS.length - 1)] ??
              30_000;
          } else {
            delay = RETRY_DELAYS[attempt] ?? 2_000;
          }
          if (this.debug) {
            console.debug(
              `[P-MATRIX] Retry ${attempt + 1}/${this.retryMax} after ${delay}ms: ${lastError.message}`
            );
          }
          await sleep(delay);
        }
      }
    }

    throw lastError;
  }

  private async fetchOnce(
    method: string,
    url: string,
    body: unknown
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    // Cross-cutting B — outgoing X-Request-ID (server middleware 정합)
    const requestId = crypto.randomUUID();

    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      };

      const response = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      // Cross-cutting B — response echo trace (verify 안 함, debug only)
      if (process.env['PMATRIX_DEBUG_TRACE'] === '1') {
        const echoed = response.headers.get('X-Request-ID');
        process.stderr.write(
          `[P-MATRIX] X-Request-ID send=${requestId} recv=${echoed ?? '(none)'}\n`
        );
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');

        // Cross-cutting C — Burst 429 handling (Retry-After 우선)
        if (response.status === 429) {
          const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
          throw new BurstRetryError(
            `HTTP 429: ${text.slice(0, 200)}`,
            retryAfterMs
          );
        }

        // Cross-cutting A — Error correlation logging (5xx)
        if (response.status >= 500) {
          this.logErrorCorrelation(response, text);
        }

        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Cross-cutting A — Error correlation logging.
   *
   * 5xx 응답에서 error_id / request_id 추출 → stderr 안내.
   * 우선순위:
   *   1. body.error.error_id  (server Production Polish A error UX 정합)
   *   2. response.headers.get('X-Error-ID')  (백업)
   *   3. body.error.request_id / X-Request-ID (correlation)
   *
   * 출력 형식:
   *   [P-MATRIX] Error 503: error_id=err_xxx request_id=req_xxx
   *     — Support 문의 시 Error ID 함께 제공해 주세요.
   */
  private logErrorCorrelation(response: Response, text: string): void {
    let errorId: string | undefined;
    let requestId: string | undefined;

    // 1) body parse — body.error.{error_id, request_id}
    if (text) {
      try {
        const body = JSON.parse(text) as {
          error?: { error_id?: string; request_id?: string };
        };
        errorId = body.error?.error_id;
        requestId = body.error?.request_id;
      } catch {
        // body 파싱 실패 → 헤더 백업으로
      }
    }

    // 2) header 백업 source
    if (!errorId) errorId = response.headers.get('X-Error-ID') ?? undefined;
    if (!requestId) requestId = response.headers.get('X-Request-ID') ?? undefined;

    process.stderr.write(
      `[P-MATRIX] Error ${response.status}: ` +
        `error_id=${errorId ?? '(none)'} request_id=${requestId ?? '(none)'} ` +
        `— Support 문의 시 Error ID 함께 제공해 주세요.\n`
    );
  }

  private async backupToLocal(signals: SignalPayload[]): Promise<void> {
    try {
      const dir = path.join(os.homedir(), '.pmatrix', 'unsent');
      await fs.promises.mkdir(dir, { recursive: true });
      const filename = path.join(dir, `${Date.now()}.json`);
      await fs.promises.writeFile(filename, JSON.stringify(signals, null, 2), 'utf-8');
    } catch {
      // silent fail — always fail-open
    }
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cross-cutting C — Burst 429 marker error.
 * fetchWithRetry uses BURST_RETRY_DELAYS escalating backoff for these.
 */
class BurstRetryError extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'BurstRetryError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse Retry-After header.
 *   - integer (delta-seconds) → ms
 *   - HTTP-date → ms diff from now (clamp >=0)
 *   - invalid / null → undefined (caller falls back to BURST_RETRY_DELAYS)
 */
function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  // delta-seconds (integer)
  const asInt = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(asInt) && /^\d+$/.test(trimmed)) {
    return Math.max(0, asInt) * 1_000;
  }
  // HTTP-date
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}
