// =============================================================================
// @pmatrix/gemini-cli-monitor — hooks/after-tool.ts
// AfterTool hook handler — 도구 결과 관찰 (관찰만, 차단 없음)
//
// 기반: @pmatrix/cursor-monitor hooks/post-tool-use.ts
// 변경:
//   - 입력 타입: CursorPostToolUseInput → GeminiAfterToolInput
//   - session_id 키: conversation_id → session_id
//   - tool_response 크기만 관찰 (Object.keys 수) — 내용 미접근
//   - mcp_context 존재 여부 기록
//   - signal_source: 'gemini_cli_hook', framework: 'gemini_cli'
//
// Privacy-first:
//   - tool_response 원문 미접근 — Object.keys(tool_response).length 만 허용
//   - tool_input 원문 미포함
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { PMatrixHttpClient } from '../client';
import { GeminiAfterToolInput, GeminiAfterToolOutput } from '../gemini-types';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';

export async function handleAfterTool(
  event: GeminiAfterToolInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<GeminiAfterToolOutput> {
  const { session_id, tool_name, tool_response, mcp_context } = event;

  const state = loadOrCreateState(session_id, config.agentId);

  // toolCallCount++ (AfterTool = 정상 완료 기준)
  state.toolCallCount += 1;

  // tool_response 크기 — 내용 미접근, 키 수(구조적 메타데이터)만 허용
  const responseKeyCount =
    tool_response && typeof tool_response === 'object'
      ? Object.keys(tool_response).length
      : 0;

  const isMcp = mcp_context != null;

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] afterTool: tool="${tool_name}" response_keys=${responseKeyCount} mcp=${isMcp} count=${state.toolCallCount}\n`
    );
  }

  // 신호 전송 (fire-and-forget)
  const signal = buildSignal(state, session_id, tool_name, responseKeyCount, isMcp, config.frameworkTag ?? 'stable');
  client.sendSignal(signal).catch(() => {});

  saveState(state);
  return {};
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  toolName: string,
  responseKeyCount: number,
  isMcp: boolean,
  frameworkTag: 'beta' | 'stable',
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0.5,
    norm: 0.0,
    stability: 0.0,   // 관찰만 — v1.0 delta 없음 (§8 AfterTool)
    meta_control: 0.5,
    timestamp: new Date().toISOString(),
    signal_source: 'gemini_cli_hook',
    framework: 'gemini_cli',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      event_type: 'after_tool',
      session_id: sessionId,
      // tool_name 원문 포함 — tool 식별 목적 (before-tool과 동일 기준)
      tool_name: toolName,
      response_key_count: responseKeyCount,
      is_mcp: isMcp,
      priority: 'normal',
    },
    state_vector: null,
  };
}
