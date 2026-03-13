// =============================================================================
// @pmatrix/gemini-cli-monitor — mcp/types.ts
// Shared MCP tool result type + helpers
// 100% reuse from @pmatrix/claude-code-monitor — framework-agnostic
// =============================================================================

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function ok(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

export function err(text: string): McpToolResult {
  return { content: [{ type: 'text', text: `⚠️ ${text}` }], isError: true };
}
