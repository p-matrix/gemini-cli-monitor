// =============================================================================
// @pmatrix/gemini-cli-monitor — hooks/pre-compress.ts
// PreCompress hook handler — 컨텍스트 압축 관찰 (관찰만, 차단 없음)
//
// 기반: @pmatrix/cursor-monitor hooks/pre-compact.ts
// 변경:
//   - 입력 타입: CursorPreCompactInput → GeminiPreCompressInput
//   - session_id 키: conversation_id → session_id
//   - context_usage_percent / message_count 없음 (Gemini: trigger만 제공)
//   - signal_source: 'gemini_cli_hook', framework: 'gemini_cli'
//
// compactCount++, trigger 필드 기록
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { PMatrixHttpClient } from '../client';
import { GeminiPreCompressInput, GeminiPreCompressOutput } from '../gemini-types';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';

export async function handlePreCompress(
  event: GeminiPreCompressInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<GeminiPreCompressOutput> {
  const { session_id, trigger } = event;

  const state = loadOrCreateState(session_id, config.agentId);

  // compactCount 증가
  state.compactCount += 1;

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] preCompress: trigger=${trigger} count=${state.compactCount}\n`
    );
  }

  // 신호 전송 (fire-and-forget)
  const signal = buildSignal(state, session_id, trigger, config.frameworkTag ?? 'stable');
  client.sendSignal(signal).catch(() => {});

  saveState(state);

  // PreCompress stdout: suppressOutput + systemMessage만 허용 (gemini-types.ts 기준)
  return {};
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  trigger: string,
  frameworkTag: 'beta' | 'stable',
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0.5,
    norm: 0.0,
    stability: 0.03,   // cursor pre-compact 동일 — 압축 = 미미한 불안정 신호 (§8)
    meta_control: 0.5,
    timestamp: new Date().toISOString(),
    signal_source: 'gemini_cli_hook',
    framework: 'gemini_cli',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      event_type: 'pre_compress',
      session_id: sessionId,
      trigger,
      compact_count: state.compactCount,
      priority: 'normal',
    },
    state_vector: null,
  };
}
