// =============================================================================
// @pmatrix/gemini-cli-monitor — mcp/tools/grade.ts
// pmatrix_grade MCP tool
//
// Shows behavioral trust grade for this agent:
//   Current grade (A–E) / P-score / expiry / grade history / dashboard link
//
// 기반: @pmatrix/claude-code-monitor mcp/tools/grade.ts
// 변경:
//   - 오류 메시지: pmatrix-gemini 참조
// =============================================================================

import { PMatrixConfig } from '../../types';
import { PMatrixHttpClient } from '../../client';
import { McpToolResult, ok, err } from '../types';

export async function handleGradeTool(
  _args: Record<string, unknown>,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<McpToolResult> {
  if (!config.agentId) {
    return err('P-MATRIX not configured. Run: pmatrix-gemini setup');
  }
  if (!config.apiKey) {
    return err('No API key. Set PMATRIX_API_KEY or run: pmatrix-gemini setup');
  }

  let detail;
  try {
    detail = await client.getAgentGradeDetail(config.agentId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Server unreachable: ${msg}`);
  }

  const lines: string[] = [];
  lines.push('─── P-MATRIX Grade ───────────────────────');

  const grade = detail.current_grade ?? '?';
  const pScore = detail.p_score != null ? detail.p_score.toFixed(1) : '—';
  const prevGrade = detail.prev_grade ?? '—';
  const prevScore = detail.prev_p_score != null ? detail.prev_p_score.toFixed(1) : '—';

  lines.push(`Current Grade : ${grade}  (P-score: ${pScore})`);
  lines.push(`Previous      : ${prevGrade}  (P-score: ${prevScore})`);

  if (detail.issued_at) {
    lines.push(`Issued        : ${detail.issued_at}`);
  }
  if (detail.expires_at) {
    lines.push(`Expires       : ${detail.expires_at}`);
  }

  // History
  if (detail.history && detail.history.length > 0) {
    lines.push('');
    lines.push('History (recent → oldest):');
    const recent = detail.history.slice(0, 5);
    for (const item of recent) {
      const score = typeof item.p_score === 'number' ? item.p_score.toFixed(1) : '—';
      const date = item.completed_at ? item.completed_at.slice(0, 10) : '';
      lines.push(`  ${item.grade}  P-score: ${score}  ${date}`);
    }
    if (detail.history.length > 5) {
      lines.push(`  … and ${detail.history.length - 5} more`);
    }
  }

  lines.push('');
  lines.push(`Dashboard : https://app.pmatrix.io`);
  lines.push(`Agent     : ${config.agentId}`);
  lines.push('─────────────────────────────────────────');

  return ok(lines.join('\n'));
}
