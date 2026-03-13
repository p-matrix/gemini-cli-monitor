// =============================================================================
// @pmatrix/gemini-cli-monitor — hooks/before-model.ts
// BeforeModel hook handler — LLM 요청 메타데이터 관측 (신규, 관찰만)
//
// 플랫폼 최초: Claude Code / Cursor는 LLM 요청 관측 불가.
// Gemini CLI BeforeModel 훅을 통해 구조적 메타데이터 관측.
//
// Content-Agnostic 경계 (§5-3):
//   ✅ 접근 허용: model, config.temperature, config.maxOutputTokens,
//                toolConfig.mode, toolConfig.allowedFunctionNames
//   ⛔ 접근 금지: llm_request.messages (사용자/시스템 메시지 본문)
//
// Flow:
//   1. HALT check (global Kill Switch)
//   2. Load session state (fail-open)
//   3. 메타데이터 추출 + 신호 전송 (관찰만 — promptTurnCount는 BeforeAgent에서만 증가)
//   4. 허용 메타데이터만 추출 → signal 전송 (event_type: 'before_model')
//   5. return {} (관찰만, 차단 없음)
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { PMatrixHttpClient } from '../client';
import { GeminiBeforeModelInput, GeminiBeforeModelOutput } from '../gemini-types';
import {
  loadOrCreateState,
  saveState,
  isHaltActive,
  PersistedSessionState,
} from '../state-store';

export async function handleBeforeModel(
  event: GeminiBeforeModelInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<GeminiBeforeModelOutput> {
  const { session_id, llm_request } = event;
  const agentId = config.agentId;

  // ① HALT check — 관찰 훅도 HALT 시 skip (서버 부하 방지)
  if (isHaltActive()) {
    return {};
  }

  // ② Load state (fail-open)
  const state = loadOrCreateState(session_id, agentId);

  // ③ llmCallCount는 AfterModel에서 finishReason 기준으로 증가 — 여기서는 관찰만

  // ④ 허용 메타데이터만 추출 (messages: INTENTIONALLY NOT ACCESSED — Content-Agnostic §5-3)
  const model = llm_request.model ?? '';
  const temperature = llm_request.config?.temperature ?? null;
  const maxOutputTokens = llm_request.config?.maxOutputTokens ?? null;
  const toolConfigMode = llm_request.toolConfig?.mode ?? null;
  const allowedFunctionNames = llm_request.toolConfig?.allowedFunctionNames ?? null;

  // model 정보를 state에 기록 (MCP 도구에서 조회 가능)
  if (model) {
    state.model = model;
  }

  const signal = buildSignal(state, session_id, {
    event_type: 'before_model',
    priority: 'normal',
    model,
    temperature,
    max_output_tokens: maxOutputTokens,
    tool_config_mode: toolConfigMode,
    allowed_function_count: allowedFunctionNames?.length ?? null,
  }, config.frameworkTag ?? 'stable');

  // fire-and-forget: 관찰 신호는 await 불필요 (차단 없음)
  client.sendSignal(signal).catch(() => {});

  saveState(state);
  return {};
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  metadata: Record<string, unknown>,
  frameworkTag: 'beta' | 'stable',
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0.5,
    norm: 0.0,
    stability: 0.5,
    meta_control: 0.5,
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
