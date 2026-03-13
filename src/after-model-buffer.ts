// =============================================================================
// @pmatrix/gemini-cli-monitor — after-model-buffer.ts
// AfterModel 턴 단위 집계 버퍼
//
// 설계 배경:
//   Gemini CLI AfterModel 훅은 스트리밍 중 청크마다 발화된다.
//   대부분의 청크에는 finishReason이 없고, 마지막 청크에만 finishReason이 포함된다.
//   → finishReason이 있는 청크에서만 서버 전송 (1턴 1회 보장)
//
//   훅 프로세스는 매 호출마다 새로 생성되므로 메모리 Map은 단일 호출 내 버퍼 역할.
//   finishReason 청크는 usageMetadata + safetyRatings + finishReason을 모두 포함하므로
//   실질적으로 accumulation 없이도 1회 전송이 가능하다.
//   (부분 청크에서 데이터가 분산되는 경우를 위한 방어적 설계)
//
// Content-Agnostic 경계:
//   - llm_response.text 접근 금지
//   - llm_response.candidates[].content 접근 금지
// =============================================================================

import { GeminiSafetyRating } from './gemini-types';

// ─── Turn Buffer schema ───────────────────────────────────────────────────────

export interface TurnBuffer {
  sessionId: string;
  /** 누적 총 토큰 수 */
  totalTokenCount: number;
  /** 누적 프롬프트 토큰 수 */
  promptTokenCount: number;
  /** 누적 후보 토큰 수 */
  candidatesTokenCount: number;
  /** 마지막으로 관찰된 safetyRatings */
  safetyRatings: GeminiSafetyRating[];
  /** 턴 완료 감지 키 — 존재 시 서버 전송 트리거 */
  finishReason: string | null;
}

/** 프로세스 레벨 Map — 같은 프로세스 내 다중 after-model 청크 누적용 */
const bufferMap = new Map<string, TurnBuffer>();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * 청크 데이터를 버퍼에 병합(merge)한다.
 *
 * 필드 병합 규칙:
 *   - tokenCount: max(기존, 신규) — 나중 청크가 더 정확한 누적값을 가짐
 *   - safetyRatings: 신규 청크 값으로 덮어쓰기 (마지막이 최신)
 *   - finishReason: null → 값으로만 전이 (한번 설정되면 유지)
 */
export function mergeChunk(
  sessionId: string,
  chunk: {
    totalTokenCount?: number;
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    safetyRatings?: GeminiSafetyRating[];
    finishReason?: string;
  }
): TurnBuffer {
  const existing = bufferMap.get(sessionId) ?? createEmptyBuffer(sessionId);

  const merged: TurnBuffer = {
    sessionId,
    totalTokenCount: Math.max(existing.totalTokenCount, chunk.totalTokenCount ?? 0),
    promptTokenCount: Math.max(existing.promptTokenCount, chunk.promptTokenCount ?? 0),
    candidatesTokenCount: Math.max(existing.candidatesTokenCount, chunk.candidatesTokenCount ?? 0),
    safetyRatings: chunk.safetyRatings ?? existing.safetyRatings,
    finishReason: chunk.finishReason ?? existing.finishReason,
  };

  bufferMap.set(sessionId, merged);
  return merged;
}

/**
 * 버퍼를 읽고 제거한다 (flush).
 * finishReason이 있을 때만 after-model.ts에서 호출.
 */
export function flushBuffer(sessionId: string): TurnBuffer | null {
  const buf = bufferMap.get(sessionId) ?? null;
  bufferMap.delete(sessionId);
  return buf;
}

/**
 * 현재 버퍼 상태 조회 (flush 없이).
 */
export function peekBuffer(sessionId: string): TurnBuffer | null {
  return bufferMap.get(sessionId) ?? null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createEmptyBuffer(sessionId: string): TurnBuffer {
  return {
    sessionId,
    totalTokenCount: 0,
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    safetyRatings: [],
    finishReason: null,
  };
}
