// =============================================================================
// @pmatrix/gemini-cli-monitor — hooks/before-tool-selection.ts
// BeforeToolSelection hook handler — 도구 목록 관찰 (관찰만, 차단 없음)
//
// 신규 (타 플랫폼 없음 — Gemini CLI 고유 훅)
//
// D-7 결정: v1.0에서는 관찰만 (allowedFunctionNames 필터링 미사용)
//   사유: 과도한 개입 위험
//
// 접근 허용 필드 (llm_request에서):
//   - toolConfig.mode (AUTO / ANY / NONE)
//   - toolConfig.allowedFunctionNames (함수명 목록)
// 접근 금지: messages (Content-Agnostic §5-3)
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { PMatrixHttpClient } from '../client';
import { GeminiBeforeToolSelectionInput, GeminiBeforeToolSelectionOutput } from '../gemini-types';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';

export async function handleBeforeToolSelection(
  event: GeminiBeforeToolSelectionInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<GeminiBeforeToolSelectionOutput> {
  const { session_id, llm_request } = event;

  const state = loadOrCreateState(session_id, config.agentId);

  // toolConfig 관찰 — messages: INTENTIONALLY NOT ACCESSED (Content-Agnostic §5-3)
  const toolConfigMode = llm_request.toolConfig?.mode ?? null;
  const allowedFunctionCount = llm_request.toolConfig?.allowedFunctionNames?.length ?? null;

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] beforeToolSelection: mode=${toolConfigMode} allowed_fn_count=${allowedFunctionCount}\n`
    );
  }

  // 신호 전송 (fire-and-forget)
  const signal = buildSignal(state, session_id, toolConfigMode, allowedFunctionCount, config.frameworkTag ?? 'stable');
  client.sendSignal(signal).catch(() => {});

  saveState(state);

  // 관찰만 — toolConfig 수정 없이 빈 객체 반환 (D-7 결정)
  return {};
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  toolConfigMode: string | null,
  allowedFunctionCount: number | null,
  frameworkTag: 'beta' | 'stable',
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0.5,
    norm: 0.0,
    stability: 0.0,
    meta_control: 0.5,
    timestamp: new Date().toISOString(),
    signal_source: 'gemini_cli_hook',
    framework: 'gemini_cli',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      event_type: 'before_tool_selection',
      session_id: sessionId,
      tool_config_mode: toolConfigMode,
      allowed_function_count: allowedFunctionCount,
      priority: 'normal',
    },
    state_vector: null,
  };
}
