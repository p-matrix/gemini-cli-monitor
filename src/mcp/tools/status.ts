// =============================================================================
// @pmatrix/gemini-cli-monitor — mcp/tools/status.ts
// pmatrix_status MCP tool
//
// Shows current P-MATRIX safety status for the active Gemini CLI session:
//   Grade / R(t) / Mode / 4-axis values / session counters
//
// 기반: @pmatrix/claude-code-monitor mcp/tools/status.ts
// 변경:
//   - findActiveSession('claude_code') → findActiveSession('gemini_cli')
//   - Session counters: Gemini 전용 필드 (llmCallCount, toolCallCount, toolDenyCount 등)
//   - 안내 메시지: pmatrix-gemini 참조
// =============================================================================

import { PMatrixConfig } from '../../types';
import { PMatrixHttpClient } from '../../client';
import {
  findActiveSession,
  loadState,
  isHaltActive,
  PersistedSessionState,
} from '../../state-store';
import { rtToMode } from '../../safety-gate';
import { McpToolResult, ok, err } from '../types';

export async function handleStatusTool(
  args: Record<string, unknown>,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<McpToolResult> {
  if (!config.agentId) {
    return err('P-MATRIX not configured. Run: pmatrix-gemini setup');
  }

  // Resolve session: provided session_id 또는 최근 활성 세션
  const sessionId =
    typeof args['session_id'] === 'string' ? args['session_id'] : null;

  const state: PersistedSessionState | null = sessionId
    ? loadState(sessionId)
    : findActiveSession('gemini_cli');

  // HALT file check
  const haltActive = isHaltActive();

  // 서버에서 실시간 grade 조회 (실패 시 로컬 캐시로 대체)
  let serverGrade: string | null = null;
  let serverRt: number | null = null;
  let serverMode: string | null = null;
  let serverAxes: { baseline: number; norm: number; stability: number; meta_control: number } | null = null;

  try {
    const gradeRes = await client.getAgentGrade(config.agentId);
    serverGrade = gradeRes.grade;
    serverRt = gradeRes.risk;
    serverMode = gradeRes.mode;
    serverAxes = gradeRes.axes;
  } catch {
    // server unavailable — use local state values
  }

  const lines: string[] = [];
  lines.push('─── P-MATRIX Status ──────────────────────');

  if (haltActive) {
    lines.push('⛔ HALT ACTIVE — all tool calls blocked');
    lines.push('   Resume: rm ~/.pmatrix/HALT');
    lines.push('');
  }

  // Grade / R(t) / Mode
  const displayGrade = serverGrade ?? state?.grade ?? '?';
  const displayRt = serverRt ?? state?.currentRt ?? 0;
  const displayMode = serverMode ?? state?.currentMode ?? rtToMode(displayRt);
  const modeLabel = modeDescription(displayMode as string);

  lines.push(`Grade  : ${displayGrade}`);
  lines.push(`R(t)   : ${displayRt.toFixed(3)}`);
  lines.push(`Mode   : ${displayMode}  ${modeLabel}`);

  if (serverAxes) {
    lines.push('');
    lines.push('4-Axis :');
    lines.push(`  BASELINE     ${serverAxes.baseline.toFixed(3)}`);
    lines.push(`  NORM         ${serverAxes.norm.toFixed(3)}`);
    lines.push(`  STABILITY    ${serverAxes.stability.toFixed(3)}`);
    lines.push(`  META_CONTROL ${serverAxes.meta_control.toFixed(3)}`);
  }

  if (state) {
    lines.push('');
    lines.push('Session :');
    lines.push(`  Prompt turns      ${state.promptTurnCount}`);
    lines.push(`  LLM calls         ${state.llmCallCount}`);
    lines.push(`  Total tokens      ${state.totalTokens}`);
    lines.push(`  Tool calls        ${state.toolCallCount}`);
    lines.push(`  Tool denies       ${state.toolDenyCount}`);
    lines.push(`  Safety gate blks  ${state.safetyGateBlocks}`);
    lines.push(`  Credential blks   ${state.credentialBlocks}`);
    lines.push(`  Policy denies     ${state.policyDenyCount}`);
    lines.push(`  Safety flags      ${state.safetyFlagCount}`);
    lines.push(`  Danger events     ${state.dangerEvents}`);
    lines.push(`  Compact count     ${state.compactCount}`);
    lines.push(`  Session ID        ${state.sessionId}`);
    lines.push(`  Model             ${state.model || '—'}`);
    lines.push(`  Started           ${state.startedAt}`);
  } else {
    lines.push('');
    lines.push('No active session found.');
    lines.push('Run Gemini CLI with pmatrix-gemini hooks installed to start monitoring.');
  }

  lines.push('');
  lines.push(`Dashboard : https://app.pmatrix.io`);
  if (config.agentId) {
    lines.push(`Agent     : ${config.agentId}`);
  }
  lines.push('─────────────────────────────────────────');

  return ok(lines.join('\n'));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function modeDescription(mode: string): string {
  const map: Record<string, string> = {
    'A+1': '(Normal)',
    'A+0': '(Caution)',
    'A-1': '(Alert)',
    'A-2': '(Critical)',
    'A-0': '(Halt)',
  };
  return map[mode] ?? '';
}
