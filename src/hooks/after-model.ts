// =============================================================================
// @pmatrix/gemini-cli-monitor — hooks/after-model.ts
// AfterModel hook handler — LLM 응답 메타데이터 관측 + 턴 완료 집계
//
// 스트리밍 guard:
//   AfterModel은 스트리밍 청크마다 발화된다.
//   finishReason이 없는 청크는 즉시 return {} — 서버 전송 없음.
//   finishReason이 있는 청크에서만 버퍼 flush + 서버 전송 (1턴 1회).
//
// Content-Agnostic 경계 (§5-3):
//   ✅ 접근 허용: usageMetadata.{promptTokenCount, candidatesTokenCount, totalTokenCount},
//                safetyRatings[].{category, probability, blocked}, finishReason
//   ⛔ 접근 금지: llm_response.text (응답 본문)
//   ⛔ 접근 금지: llm_response.candidates[].content (후보 본문)
//
// Flow:
//   1. finishReason 없음 → return {} (스트리밍 청크 무시)
//   2. finishReason 있음 → mergeChunk → flushBuffer
//   3. finishReason === 'SAFETY' → safetyFlagCount++, norm delta +0.05
//   4. llmCallCount++, totalTokens += totalTokenCount
//   5. signal 전송 (event_type: 'after_model')
//   6. state 저장
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { PMatrixHttpClient } from '../client';
import { GeminiAfterModelInput, GeminiAfterModelOutput } from '../gemini-types';
import { mergeChunk, flushBuffer } from '../after-model-buffer';
import {
  loadOrCreateState,
  saveState,
  isHaltActive,
  PersistedSessionState,
} from '../state-store';

export async function handleAfterModel(
  event: GeminiAfterModelInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<GeminiAfterModelOutput> {
  const { session_id, llm_response } = event;
  const agentId = config.agentId;

  // ① 스트리밍 guard — finishReason 없는 청크: 즉시 return {} (서버 미전송)
  const finishReason = llm_response.finishReason ?? null;
  if (!finishReason) {
    // 부분 데이터도 버퍼에 병합 (다음 청크에서 활용)
    mergeChunk(session_id, {
      totalTokenCount: llm_response.usageMetadata?.totalTokenCount,
      promptTokenCount: llm_response.usageMetadata?.promptTokenCount,
      candidatesTokenCount: llm_response.usageMetadata?.candidatesTokenCount,
      safetyRatings: llm_response.safetyRatings,
    });
    return {};
  }

  // ② finishReason 있음 → 마지막 청크 병합 후 flush
  mergeChunk(session_id, {
    totalTokenCount: llm_response.usageMetadata?.totalTokenCount,
    promptTokenCount: llm_response.usageMetadata?.promptTokenCount,
    candidatesTokenCount: llm_response.usageMetadata?.candidatesTokenCount,
    safetyRatings: llm_response.safetyRatings,
    finishReason,
  });
  const buf = flushBuffer(session_id);

  // HALT check — 관찰 훅도 HALT 시 skip
  if (isHaltActive()) {
    return {};
  }

  // ③ Load state (fail-open)
  const state = loadOrCreateState(session_id, agentId);

  // ④ SAFETY finishReason → safetyFlagCount++ (위험 신호)
  const isSafetyBlock = finishReason === 'SAFETY';
  if (isSafetyBlock) {
    state.safetyFlagCount += 1;
  }

  // ⑤ llmCallCount++, totalTokens 누적
  state.llmCallCount += 1;
  const totalTokenCount = buf?.totalTokenCount ?? llm_response.usageMetadata?.totalTokenCount ?? 0;
  state.totalTokens += totalTokenCount;

  // norm delta: SAFETY 차단 시 +0.05 (규범 위반 신호)
  const normDelta = isSafetyBlock ? 0.05 : 0.0;

  // ⑥ 허용 메타데이터만 추출 (text/candidates[].content: INTENTIONALLY NOT ACCESSED — §5-3)
  const safetyRatings = buf?.safetyRatings ?? llm_response.safetyRatings ?? [];
  const safetyBlocked = safetyRatings.some((r) => r.blocked === true);
  const safetyCategories = safetyRatings.map((r) => r.category);

  const signal = buildSignal(state, session_id, {
    event_type: 'after_model',
    priority: 'normal',
    finish_reason: finishReason,
    total_token_count: totalTokenCount,
    prompt_token_count: buf?.promptTokenCount ?? llm_response.usageMetadata?.promptTokenCount ?? 0,
    candidates_token_count: buf?.candidatesTokenCount ?? llm_response.usageMetadata?.candidatesTokenCount ?? 0,
    safety_blocked: safetyBlocked,
    safety_categories: safetyCategories,
  }, config.frameworkTag ?? 'stable', normDelta);

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
  normDelta: number = 0.0,
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0.5,
    norm: normDelta,
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
