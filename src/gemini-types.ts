// =============================================================================
// @pmatrix/gemini-cli-monitor — gemini-types.ts
// Gemini CLI hook stdin/stdout 전체 타입 정의 (11개 훅)
//
// Sources:
//   - PMATRIX_GEMINI_CLI_MONITOR_RESEARCH_v1_1.md §1-2 ~ §1-5
//   - Gemini CLI Hook Reference (geminicli.com)
//
// Content-Agnostic 경계:
//   - llm_request.messages, llm_response.text, llm_response.candidates[].content
//     접근 코드를 이 파일에 추가하는 것을 금지 (§5-3)
// =============================================================================

// ─── 공통 stdin 베이스 (모든 훅) ──────────────────────────────────────────────

export interface GeminiHookBase {
  /** 세션 ID — 상태 파일 키 */
  session_id: string;
  /** 트랜스크립트 절대 경로 */
  transcript_path: string;
  /** 작업 디렉토리 */
  cwd: string;
  /** 훅 이벤트명 */
  hook_event_name: string;
  /** ISO 8601 타임스탬프 */
  timestamp: string;
}

// ─── 공통 stdout 베이스 (모든 훅) ─────────────────────────────────────────────

export interface GeminiHookOutput {
  /** false → 에이전트 루프 중단 */
  continue?: boolean;
  /** continue=false 시 표시 메시지 */
  stopReason?: string;
  /** 출력 억제 */
  suppressOutput?: boolean;
  /** 컨텍스트 주입 문자열 */
  systemMessage?: string;
  /** 게이팅 결정 */
  decision?: 'allow' | 'deny' | 'block' | 'approve' | 'ask';
  /** decision=deny 시 필수 */
  reason?: string;
  /** 훅별 추가 출력 */
  hookSpecificOutput?: Record<string, unknown>;
}

// ─── 1. SessionStart ──────────────────────────────────────────────────────────

export interface GeminiSessionStartInput extends GeminiHookBase {
  /** 세션 시작 원인 */
  source: 'startup' | 'resume' | 'clear';
}

export interface GeminiSessionStartOutput extends GeminiHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'SessionStart';
    additionalContext?: string;
  };
}

// ─── 2. SessionEnd ────────────────────────────────────────────────────────────

export interface GeminiSessionEndInput extends GeminiHookBase {
  /** 종료 원인 */
  reason: 'exit' | 'clear' | 'logout' | 'prompt_input_exit' | 'other';
}

// SessionEnd stdout: systemMessage만 허용. exit codes 무시됨.
export type GeminiSessionEndOutput = Pick<GeminiHookOutput, 'systemMessage'>;

// ─── 3. BeforeAgent ───────────────────────────────────────────────────────────

export interface GeminiBeforeAgentInput extends GeminiHookBase {
  /** 사용자 프롬프트 — Content-Agnostic: 내용 읽기/저장/전송 금지, 패턴 매칭(credential 감지)만 허용 */
  prompt: string;
}

export interface GeminiBeforeAgentOutput extends GeminiHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'BeforeAgent';
    additionalContext?: string;
  };
}

// ─── 4. AfterAgent ────────────────────────────────────────────────────────────

export interface GeminiAfterAgentInput extends GeminiHookBase {
  /** 사용자 프롬프트 (Content-Agnostic) */
  prompt: string;
  /** 에이전트 응답 (Content-Agnostic) */
  prompt_response: string;
  /** 재시도 시퀀스 여부 */
  stop_hook_active: boolean;
}

export interface GeminiAfterAgentOutput extends GeminiHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'AfterAgent';
    clearContext?: boolean;
  };
}

// ─── 5. BeforeModel ★ LLM 요청 관측 ──────────────────────────────────────────

/** LLM 요청 메타데이터 — Content-Agnostic: messages 필드 접근 금지 */
export interface GeminiLLMRequestMeta {
  model: string;
  config?: {
    temperature?: number;
    maxOutputTokens?: number;
    [key: string]: unknown;
  };
  toolConfig?: {
    mode?: 'AUTO' | 'ANY' | 'NONE';
    allowedFunctionNames?: string[];
  };
  // messages: INTENTIONALLY OMITTED — Content-Agnostic 경계 §5-3
}

export interface GeminiBeforeModelInput extends GeminiHookBase {
  llm_request: GeminiLLMRequestMeta;
}

export interface GeminiBeforeModelOutput extends GeminiHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'BeforeModel';
    llm_request?: Partial<GeminiLLMRequestMeta>;
  };
}

// ─── 6. AfterModel ★ LLM 응답 관측 ───────────────────────────────────────────

export interface GeminiSafetyRating {
  category: string;
  probability: string;
  blocked?: boolean;
}

/** LLM 응답 메타데이터 — Content-Agnostic: text/candidates[].content 접근 금지 */
export interface GeminiLLMResponseMeta {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  safetyRatings?: GeminiSafetyRating[];
  /** 턴 완료 감지 키 — STOP/MAX_TOKENS/SAFETY/OTHER */
  finishReason?: string;
  // text: INTENTIONALLY OMITTED — Content-Agnostic 경계 §5-3
  // candidates[].content: INTENTIONALLY OMITTED — Content-Agnostic 경계 §5-3
}

export interface GeminiAfterModelInput extends GeminiHookBase {
  llm_request: GeminiLLMRequestMeta;
  llm_response: GeminiLLMResponseMeta;
}

export interface GeminiAfterModelOutput extends GeminiHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'AfterModel';
  };
}

// ─── 7. BeforeTool ★ Safety Gate 핵심 ────────────────────────────────────────

export interface GeminiMCPContext {
  server_name: string;
  tool_name: string;
  command?: string;
  url?: string;
}

export interface GeminiBeforeToolInput extends GeminiHookBase {
  /** 도구명 (e.g., read_file, mcp_myserver_mytool) */
  tool_name: string;
  /** 모델 생성 인수 */
  tool_input: Record<string, unknown>;
  /** MCP 서버 컨텍스트 (MCP 도구인 경우) */
  mcp_context?: GeminiMCPContext;
  /** tail call 시 원래 도구명 */
  original_request_name?: string;
}

export interface GeminiBeforeToolOutput extends GeminiHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'BeforeTool';
    /** 인수 덮어쓰기 (optional) */
    tool_input?: Record<string, unknown>;
  };
}

// ─── 8. AfterTool ─────────────────────────────────────────────────────────────

export interface GeminiAfterToolInput extends GeminiHookBase {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  mcp_context?: GeminiMCPContext;
}

export interface GeminiAfterToolOutput extends GeminiHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'AfterTool';
    additionalContext?: string;
    tailToolCallRequest?: {
      name: string;
      args: Record<string, unknown>;
    };
  };
}

// ─── 9. BeforeToolSelection ───────────────────────────────────────────────────

export interface GeminiBeforeToolSelectionInput extends GeminiHookBase {
  llm_request: GeminiLLMRequestMeta;
}

export interface GeminiBeforeToolSelectionOutput extends GeminiHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'BeforeToolSelection';
    toolConfig?: {
      mode?: 'AUTO' | 'ANY' | 'NONE';
      allowedFunctionNames?: string[];
    };
  };
}

// ─── 10. PreCompress ──────────────────────────────────────────────────────────

export interface GeminiPreCompressInput extends GeminiHookBase {
  /** 압축 트리거 */
  trigger: 'auto' | 'manual';
}

// PreCompress stdout: suppressOutput + systemMessage만 허용
export type GeminiPreCompressOutput = Pick<GeminiHookOutput, 'suppressOutput' | 'systemMessage'>;

// ─── 11. Notification ─────────────────────────────────────────────────────────

export interface GeminiNotificationInput extends GeminiHookBase {
  /** 알림 타입 (현재 1종) */
  notification_type: 'ToolPermission';
  /** 알림 메시지 */
  message: string;
  /** 상세 정보 */
  details: Record<string, unknown>;
}

// Notification stdout: suppressOutput + systemMessage만 허용
export type GeminiNotificationOutput = Pick<GeminiHookOutput, 'suppressOutput' | 'systemMessage'>;
