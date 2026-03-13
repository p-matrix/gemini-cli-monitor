// =============================================================================
// @pmatrix/gemini-cli-monitor — hooks/before-agent.ts
// BeforeAgent handler — Credential Scanner
//
// 기반: @pmatrix/cursor-monitor hooks/before-submit-prompt.ts
// 변경:
//   - CursorBeforeSubmitPromptInput → GeminiBeforeAgentInput (gemini-types.ts)
//   - 상태 파일 키: session_id (Gemini 공통 — GeminiHookBase)
//   - 차단 출력: { continue: false, stopReason: "..." } (Gemini BeforeAgent 공식 포맷)
//   - 통과 출력: {} (빈 객체 — Gemini stdout 불필요 시 빈 출력)
//   - signal_source: 'gemini_cli_hook', framework: 'gemini_cli'
//
// 처리 흐름:
//   ① promptTurnCount 증가 (항상)
//   ② credentialProtection.enabled 체크 → false면 통과
//   ③ scanCredentials(prompt) → hits
//   ④ hits 있으면:
//      - credentialBlocks (API payload) + credentialBlockCount (Gemini stat) 동시 증가
//      - dangerEvents 증가
//      - sendCritical (credential_detected 신호)
//      - return { continue: false, stopReason: "..." }
//   ⑤ hits 없으면:
//      - return {}
//
// stdout 포맷 (Gemini BeforeAgent 공식):
//   { "continue": false, "stopReason": "..." }  ← 차단 시
//   {}                                           ← 통과 시
//
// ⚠ prompt 원문은 저장·전송하지 않음 (privacy-first §5.4)
//    credential_count / credential_types 만 신호에 포함
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { GeminiBeforeAgentInput, GeminiBeforeAgentOutput } from '../gemini-types';
import { PMatrixHttpClient } from '../client';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';
import { scanCredentials } from '../credential-scanner';

export async function handleBeforeAgent(
  event: GeminiBeforeAgentInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<GeminiBeforeAgentOutput> {
  const sessionId = event.session_id;
  const { prompt } = event;

  const state = loadOrCreateState(sessionId, config.agentId);

  // ① promptTurnCount 증가 (항상 — 차단 여부 무관)
  state.promptTurnCount += 1;

  // ② credentialProtection 비활성화 시 — 통과
  if (!config.credentialProtection.enabled) {
    saveState(state);
    return {};
  }

  // ③ Credential 스캔
  const hits = prompt ? scanCredentials(prompt, config.credentialProtection.customPatterns) : [];

  if (hits.length > 0) {
    // ④ 카운터 증가 (두 곳 동시 — PM 확정 설계)
    state.credentialBlocks += 1;        // API payload 필드
    state.credentialBlockCount += 1;    // Gemini stat 필드
    state.dangerEvents += 1;

    const credentialTypes = hits.map(h => h.name).join(', ');
    const totalCount = hits.reduce((sum, h) => sum + h.count, 0);

    if (config.debug) {
      process.stderr.write(
        `[P-MATRIX] beforeAgent: credential detected — ${credentialTypes} (count=${totalCount})\n`
      );
    }

    // 신호 전송 (type/count만 — 프롬프트 원문 미포함 §5.4)
    if (config.dataSharing) {
      const signal = buildCredentialSignal(state, sessionId, totalCount, credentialTypes, config.frameworkTag ?? 'stable');
      client.sendCritical(signal).catch(() => {});
    }

    saveState(state);

    return {
      continue: false,
      stopReason: `[P-MATRIX] Credential detected in prompt (${credentialTypes}). Please remove sensitive data before submitting.`,
    };
  }

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] beforeAgent: turn=${state.promptTurnCount} session=${sessionId}\n`
    );
  }

  saveState(state);
  return {};
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildCredentialSignal(
  state: PersistedSessionState,
  sessionId: string,
  credentialCount: number,
  credentialTypes: string,
  frameworkTag: 'beta' | 'stable'
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0,
    norm: 0,
    stability: 0.10,
    meta_control: 0,
    timestamp: new Date().toISOString(),
    signal_source: 'gemini_cli_hook',
    framework: 'gemini_cli',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      event_type: 'credential_detected',
      session_id: sessionId,
      credential_count: credentialCount,
      // credential_types = pattern names only — never matched values (§5.4)
      credential_types: credentialTypes,
      priority: 'critical',
    },
    state_vector: null,
  };
}
