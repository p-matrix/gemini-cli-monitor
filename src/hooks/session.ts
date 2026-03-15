// =============================================================================
// @pmatrix/gemini-cli-monitor — hooks/session.ts
// sessionStart / sessionEnd lifecycle handlers
//
// 기반: @pmatrix/cursor-monitor hooks/session.ts
// 변경:
//   - CursorSessionStartInput → GeminiSessionStartInput (gemini-types.ts)
//   - CursorSessionEndInput   → GeminiSessionEndInput   (gemini-types.ts)
//   - 상태 파일 키: session_id (GeminiHookBase 공통 필드 — Gemini는 전 훅에서 session_id 통일)
//   - source 필드 저장 (startup / resume / clear)
//   - reason 값: exit / clear / logout / prompt_input_exit / other
//   - signal_source: 'gemini_cli_hook', framework: 'gemini_cli'
//
// sessionStart:
//   - Create/restore session state
//   - Gemini 메타데이터 저장 (source, model, workspaceRoot)
//   - Send session_start signal (fire-and-forget)
//   - Cleanup stale session files
//   - No stdout output required (non-blocking 훅)
//
// sessionEnd:
//   - Send session_summary signal
//   - Delete session state file
// =============================================================================

import {
  PMatrixConfig,
  SignalPayload,
} from '../types';
import {
  GeminiSessionStartInput,
  GeminiSessionEndInput,
} from '../gemini-types';
import { PMatrixHttpClient, SessionSummaryInput } from '../client';
import {
  loadOrCreateState,
  saveState,
  deleteState,
  cleanupStaleStates,
  PersistedSessionState,
} from '../state-store';
import { deleteFieldState } from '@pmatrix/field-node-runtime';

// ─── sessionStart ─────────────────────────────────────────────────────────────

export async function handleSessionStart(
  event: GeminiSessionStartInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  // GM-2: SDK SessionContext 방어 — session_id 계약 깨짐 방지
  const sessionId = event.session_id ?? (event as unknown as Record<string, unknown>)['sessionId'] as string | undefined;
  if (!sessionId || typeof sessionId !== 'string') {
    if (config.debug) {
      process.stderr.write(
        `[P-MATRIX] sessionStart: session_id missing or invalid, skipping\n`
      );
    }
    return;  // fail-open: 상태 생성하지 않음
  }
  const agentId = config.agentId;

  // Cleanup stale sessions opportunistically (non-blocking)
  cleanupStaleStates();

  // Load or create session state
  const state = loadOrCreateState(sessionId, agentId);

  // Gemini 전용 메타데이터 저장
  state.sessionSource = event.source;
  state.workspaceRoot = process.env['GEMINI_PROJECT_DIR'] ?? event.cwd ?? '';

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] sessionStart: key=${sessionId} agent=${agentId} ` +
      `source=${event.source} cwd=${event.cwd}\n`
    );
  }

  // Send session_start signal (fire-and-forget)
  if (config.dataSharing) {
    const signal = buildSessionSignal(state, sessionId, {
      event_type: 'session_start',
      session_source: event.source,
      priority: 'normal',
    }, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});
  }

  // Retry unsent backlog from previous sessions (60s throttle, fail-open)
  client.resubmitUnsent().catch(() => {});

  saveState(state);
}

// ─── sessionEnd ───────────────────────────────────────────────────────────────

export async function handleSessionEnd(
  event: GeminiSessionEndInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  // session_id 통일 키 사용
  const sessionId = event.session_id;
  const { reason } = event;
  const agentId = config.agentId;

  const state = loadOrCreateState(sessionId, agentId);

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] sessionEnd: key=${sessionId} turns=${state.promptTurnCount} ` +
      `grade=${state.grade ?? 'N/A'} halted=${state.isHalted} reason=${reason}\n`
    );
  }

  // Send session summary (dataSharing required)
  if (config.dataSharing) {
    const summaryInput: SessionSummaryInput = {
      sessionId,
      agentId,
      totalTurns: state.promptTurnCount,
      dangerEvents: state.dangerEvents,
      credentialBlocks: state.credentialBlocks,
      safetyGateBlocks: state.safetyGateBlocks,
      endReason: reason,
      signal_source: 'gemini_cli_hook',
      framework: 'gemini_cli',
      framework_tag: config.frameworkTag ?? 'stable',
    };
    await client.sendSessionSummary(summaryInput).catch(() => {});
  }

  // Clean up session state
  deleteState(sessionId);
  deleteFieldState(sessionId);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSessionSignal(
  state: PersistedSessionState,
  sessionId: string,
  metadata: Record<string, unknown>,
  frameworkTag: 'beta' | 'stable'
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0,
    norm: 0,
    stability: 0,
    meta_control: 0,
    timestamp: new Date().toISOString(),
    signal_source: 'gemini_cli_hook',
    framework: 'gemini_cli',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      session_id: sessionId,
      ...metadata,
    },
    state_vector: null,
  };
}
