// =============================================================================
// @pmatrix/gemini-cli-monitor — hooks/after-agent.ts
// AfterAgent hook handler — 에이전트 응답 완료 관찰 (관찰만, 차단 없음)
//
// 기반: @pmatrix/cursor-monitor hooks/before-submit-prompt.ts (구조만)
// 변경:
//   - 입력 타입: GeminiAfterAgentInput
//   - prompt / prompt_response 내용 미접근 (Content-Agnostic)
//   - promptTurnCount는 BeforeAgent/BeforeModel에서 이미 증가 — 여기서는 관찰만
//   - stop_hook_active 필드 기록 (반복 루프 감지용)
//
// Content-Agnostic:
//   - prompt 원문 미접근
//   - prompt_response 원문 미접근
//   - 길이(length)만 관찰 허용
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { PMatrixHttpClient } from '../client';
import { GeminiAfterAgentInput, GeminiAfterAgentOutput } from '../gemini-types';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';

export async function handleAfterAgent(
  event: GeminiAfterAgentInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<GeminiAfterAgentOutput> {
  const { session_id, prompt, prompt_response, stop_hook_active } = event;

  const state = loadOrCreateState(session_id, config.agentId);

  // prompt / prompt_response 내용 미접근 — 길이(구조적 메타데이터)만 허용
  const promptLength = typeof prompt === 'string' ? prompt.length : 0;
  const responseLength = typeof prompt_response === 'string' ? prompt_response.length : 0;

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] afterAgent: turn=${state.promptTurnCount} stop_hook=${stop_hook_active} prompt_len=${promptLength}\n`
    );
  }

  // 신호 전송 (fire-and-forget)
  const signal = buildSignal(
    state, session_id,
    promptLength, responseLength, stop_hook_active ?? false,
    config.frameworkTag ?? 'stable'
  );
  client.sendSignal(signal).catch(() => {});

  saveState(state);
  return {};
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  promptLength: number,
  responseLength: number,
  stopHookActive: boolean,
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
      event_type: 'after_agent',
      session_id: sessionId,
      // 원문 미포함 — 길이(구조적 메타데이터)만 (Content-Agnostic §5-3)
      prompt_length: promptLength,
      response_length: responseLength,
      stop_hook_active: stopHookActive,
      total_turns: state.promptTurnCount,
      priority: 'normal',
    },
    state_vector: null,
  };
}
