// =============================================================================
// @pmatrix/gemini-cli-monitor — client.ts
// PMatrixHttpClient: POST /v1/inspect/stream, GET /v1/agents/{id}/public
// 95% reuse from @pmatrix/cursor-monitor — signal_source + framework changed
// signal_source: 'gemini_cli_hook', framework: 'gemini_cli'
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

// ─── Constants ────────────────────────────────────────────────────────────────

const RETRY_DELAYS = [100, 500, 2_000] as const;
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
  private lastResubmitAt: number = 0;

  constructor(config: PMatrixConfig) {
    this.baseUrl = config.serverUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.agentId = config.agentId;
    this.retryMax = config.batch.retryMax;
    this.debug = config.debug;
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
    // TODO(runtime-guard): validate shape at runtime if payload schema drifts
    return raw as GradeResponse;
  }

  async getAgentGradeDetail(agentId: string): Promise<AgentGradeDetail> {
    const url = `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/grade`;
    const raw = await this.fetchWithRetry('GET', url, null);
    // TODO(runtime-guard): validate shape at runtime if payload schema drifts
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
    const url = `${this.baseUrl}/v1/inspect/stream`;
    const body = signals.length === 1 ? signals[0] : signals;
    const raw = await this.fetchWithRetry('POST', url, body);
    // TODO(runtime-guard): validate shape at runtime if payload schema drifts
    return (raw as BatchSendResponse | null) ?? { received: signals.length };
  }

  private async fetchWithRetry(
    method: string,
    url: string,
    body: unknown
  ): Promise<unknown> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 0; attempt <= this.retryMax; attempt++) {
      try {
        return await this.fetchOnce(method, url, body);
      } catch (err) {
        lastError = err as Error;
        if (attempt < this.retryMax) {
          const delay = RETRY_DELAYS[attempt] ?? 2_000;
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

    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      };

      const response = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timeoutId);
    }
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
