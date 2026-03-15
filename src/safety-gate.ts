// =============================================================================
// @pmatrix/gemini-cli-monitor — safety-gate.ts
// Safety Gate pure logic — Gemini CLI 도구 위험 분류 + gate matrix
//
// 기반: @pmatrix/cursor-monitor safety-gate.ts
// 변경:
//   - HIGH_RISK_TOOLS / MEDIUM_RISK_TOOLS → Gemini CLI 빌트인 도구명 세트로 교체
//   - classifyShellCommandRisk() 제거 → classifyGeminiToolRisk() 신규 (write_file 경로 검사 포함)
//   - checkMetaControlRules() — run_shell_command 원문 직접 분석
//   - META_CONTROL_RULES — 3패키지 표준 5개 세트 (cursor-monitor와 동일)
//   - evaluateSafetyGate(), rtToMode(), GateResult — 변경 없음 (100% 재사용)
//
// Gemini 특이점:
//   - run_shell_command: 셸 명령 원문(tool_input.command) 직접 분석 가능
//   - write_file: tool_input.path로 시스템 경로 판별 가능
//   - MCP 도구: tool_name prefix로 분류 (pmatrix_* → early allow in before-tool)
//
// Content-Agnostic 경계:
//   - tool_input.command, tool_input.path 등 구조적 파라미터만 접근
//   - llm_request.messages, llm_response.text 접근 금지 (§5-3)
// =============================================================================

import { ToolRiskTier, GateAction, SafetyMode } from './types';

// ─── Gemini CLI 빌트인 도구 위험 분류 ─────────────────────────────────────────
//
// HIGH: 단독으로 R(t) 관계없이 높은 잠재적 피해 (시스템 경로 쓰기, 복합 실행)
// MEDIUM: 조건부 위험 — R(t) 조건에서 차단 가능
// LOW: 읽기/탐색 — 원칙적으로 허용
//
// run_shell_command: 기본값 MEDIUM (meta_control 5규칙에서 HIGH 패턴 처리)
// write_file + 시스템 경로: HIGH (tool_input.path 검사, classifyGeminiToolRisk 내부)

const HIGH_RISK_TOOLS = new Set([
  'multi_tool_use',      // 복합 실행 — 우회 공격 벡터
]);

const MEDIUM_RISK_TOOLS = new Set([
  'run_shell_command',   // 셸 실행 — 기본 MEDIUM (meta-control이 HIGH 패턴 포착)
  'write_file',          // 파일 쓰기 — 일반 경로 MEDIUM (시스템 경로는 HIGH로 상향)
  'create_file',         // 파일 생성
  'edit',                // 파일 편집
  'web_fetch',           // 웹 요청
  'http_request',        // HTTP 요청
]);

const LOW_TOOL_PREFIXES = [
  'pmatrix_',            // P-MATRIX MCP 자가 도구 — 재귀 방지 (before-tool.ts에서 early allow)
  'read_file',
  'list_directory',
  'search_files',
  'find_files',
  'glob',
  'grep',
  'get_file',
  'view_file',
  'read',
  'list',
  'search',
  'show',
  'enter_plan_mode',    // Gemini CLI v0.29.0+ Plan Mode (읽기전용)
  'exit_plan_mode',     // Plan Mode 종료도 동일
];

/**
 * 시스템 경로 prefix — write_file/create_file 경로 검사에 사용
 * 이 경로로 쓰기 시도 → HIGH 위험 등급 상향
 */
const SYSTEM_PATH_PREFIXES = [
  '/etc/',
  '/sys/',
  '/proc/',
  '/sbin/',
  '/usr/bin/',
  '/usr/sbin/',
  '/bin/',
  '/boot/',
  '/dev/',
] as const;

/**
 * Gemini CLI 도구 위험 분류
 *
 * classifyGeminiToolRisk(toolName, toolInput?)
 *   - toolInput이 있으면 write_file 경로 + run_shell_command 패턴 정밀 분류
 *   - toolInput 없어도 fail-safe 기본값 적용 (write_file → MEDIUM)
 *
 * claude-code-monitor와의 차이:
 *   - claude-code-monitor: tool_input 미접근 (privacy-first)
 *   - gemini-cli-monitor:  tool_input 구조적 파라미터(path, command) 접근 (D-3 결정)
 */
export function classifyGeminiToolRisk(
  toolName: string,
  toolInput?: Record<string, unknown>,
  customToolRisk?: Record<string, ToolRiskTier>
): ToolRiskTier {
  if (customToolRisk) {
    const custom = customToolRisk[toolName];
    if (custom) return custom;
  }

  const lower = toolName.toLowerCase();

  // pmatrix_* MCP 자가 도구 — LOW (early allow는 before-tool.ts에서 처리)
  if (lower.startsWith('pmatrix_')) return 'LOW';

  // 읽기/탐색 도구 — LOW
  if (LOW_TOOL_PREFIXES.some((prefix) => lower.startsWith(prefix))) return 'LOW';

  // 복합 실행 — HIGH
  if (HIGH_RISK_TOOLS.has(lower)) return 'HIGH';

  // write_file / create_file: 경로 기반 상향 판정
  if (lower === 'write_file' || lower === 'create_file') {
    if (toolInput) {
      const filePath =
        (toolInput['path'] as string | undefined) ??
        (toolInput['filename'] as string | undefined) ??
        (toolInput['file_path'] as string | undefined) ??
        '';
      if (typeof filePath === 'string' && filePath.length > 0) {
        if (SYSTEM_PATH_PREFIXES.some((p) => filePath.startsWith(p))) return 'HIGH';
      }
    }
    return 'MEDIUM';
  }

  if (MEDIUM_RISK_TOOLS.has(lower)) return 'MEDIUM';

  return 'MEDIUM';  // conservative default (MCP 미등록 도구: unknown → MEDIUM)
}

// ─── R(t) → Mode boundaries (Server constants.py, §14-4) ─────────────────────

export const MODE_BOUNDARIES: Readonly<Record<SafetyMode, readonly [number, number]>> = {
  'A+1': [0.00, 0.15],  // Normal
  'A+0': [0.15, 0.30],  // Caution
  'A-1': [0.30, 0.50],  // Alert
  'A-2': [0.50, 0.75],  // Critical
  'A-0': [0.75, 1.00],  // Halt
} as const;

export function rtToMode(rt: number): SafetyMode {
  if (rt < 0.15) return 'A+1';
  if (rt < 0.30) return 'A+0';
  if (rt < 0.50) return 'A-1';
  if (rt < 0.75) return 'A-2';
  return 'A-0';
}

// ─── Safety Gate matrix (§3-1) ────────────────────────────────────────────────

export interface GateResult {
  action: GateAction;
  reason: string;
}

/**
 * Safety Gate 판정 매트릭스 (§3-1)
 *
 * | R(t)       | Mode     | HIGH    | MEDIUM  | LOW   |
 * |------------|----------|---------|---------|-------|
 * | < 0.15     | Normal   | ALLOW   | ALLOW   | ALLOW |
 * | 0.15~0.30  | Caution  | BLOCK   | ALLOW   | ALLOW |
 * | 0.30~0.50  | Alert    | BLOCK   | ALLOW   | ALLOW |
 * | 0.50~0.75  | Critical | BLOCK   | BLOCK   | ALLOW |
 * | ≥ 0.75     | Halt     | BLOCK   | BLOCK   | BLOCK |
 */
export function evaluateSafetyGate(
  rt: number,
  toolRisk: ToolRiskTier
): GateResult {
  const mode = rtToMode(rt);
  const rtStr = rt.toFixed(2);

  if (mode === 'A-0') {
    return {
      action: 'BLOCK',
      reason: `HALT: R(t) ${rtStr} ≥ 0.75 — all tools blocked`,
    };
  }

  if (mode === 'A-2') {
    if (toolRisk === 'HIGH' || toolRisk === 'MEDIUM') {
      return {
        action: 'BLOCK',
        reason: `Critical zone R(t) ${rtStr} — ${toolRisk.toLowerCase()}-risk tool blocked`,
      };
    }
    return { action: 'ALLOW', reason: '' };
  }

  if (mode === 'A-1' || mode === 'A+0') {
    if (toolRisk === 'HIGH') {
      return {
        action: 'BLOCK',
        reason: `Elevated R(t) ${rtStr} — high-risk tool blocked`,
      };
    }
    return { action: 'ALLOW', reason: '' };
  }

  return { action: 'ALLOW', reason: '' };
}

// ─── meta_control 특수 규칙 (5개, 3패키지 표준) ───────────────────────────────
//
// Gemini 적용:
//   - run_shell_command → tool_input.command 원문 직접 분석
//   - before-tool.ts에서 tool_name === 'run_shell_command'이면 command 추출 후 전달
//   - 다른 도구: toolName 자체를 command로 전달 (패턴 미매칭 → null 반환)

export interface MetaControlBlockResult {
  reason: string;
  metaControlDelta: number;
}

interface MetaControlRule {
  pattern: RegExp;
  reason: string;
  metaControlDelta: number;
}

// LL-6: META_CONTROL_RULES — 3패키지 표준 5개 세트 (cursor/claude-code-monitor와 동일)
const META_CONTROL_RULES: readonly MetaControlRule[] = [
  {
    pattern: /rm\s+-rf\s+(\/(?!tmp|var\/tmp)[^\s]*|~)/i,
    reason: 'Destructive deletion detected (rm -rf)',
    metaControlDelta: -0.30,
  },
  {
    pattern: /\bsudo\b.*rm|sudo\s+mkfs|sudo\s+dd/i,
    reason: 'Privilege escalation + destructive command',
    metaControlDelta: -0.25,
  },
  {
    pattern: /(?:curl|wget)\s+[^\|]+\|\s*(?:ba)?sh\b/i,
    reason: 'Remote code execution pattern (curl/wget | sh)',
    metaControlDelta: -0.20,
  },
  {
    pattern: /base64\s+(?:--decode|-d)\s+.*\|\s*(?:ba)?sh\b/i,
    reason: 'Obfuscated RCE pattern (base64 decode | sh)',
    metaControlDelta: -0.25,
  },
  {
    pattern: /chmod\s+777\s+\//i,
    reason: 'Dangerous permission change (chmod 777 /)',
    metaControlDelta: -0.15,
  },
] as const;

/**
 * checkMetaControlRules — run_shell_command 원문 직접 분석
 *
 * cursor-monitor와 동일 인터페이스:
 *   checkMetaControlRules(command, null)
 *   - command: run_shell_command → tool_input.command, 그 외 → tool_name
 *   - 두 번째 파라미터(_params)는 호환성 유지를 위해 보존하되 미사용
 */
export function checkMetaControlRules(
  command: string,
  _params: unknown
): MetaControlBlockResult | null {
  for (const rule of META_CONTROL_RULES) {
    if (rule.pattern.test(command)) {
      return {
        reason: rule.reason,
        metaControlDelta: rule.metaControlDelta,
      };
    }
  }
  return null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function serializeParams(params: unknown): string {
  if (params == null) return '';
  if (typeof params === 'string') return params;
  try {
    return JSON.stringify(params);
  } catch {
    return String(params);
  }
}
