// =============================================================================
// @pmatrix/gemini-cli-monitor — mcp/server.ts
// P-MATRIX MCP stdio server
//
// Exposes 3 MCP tools:
//   pmatrix_status — R(t)/Grade/Mode/session counters
//   pmatrix_grade  — trust grade + history + dashboard link
//   pmatrix_halt   — global Kill Switch (creates ~/.pmatrix/HALT)
//
// Started by: pmatrix-gemini mcp
// Transport:  stdio (Gemini CLI MCP protocol)
//
// 기반: @pmatrix/claude-code-monitor mcp/server.ts — 변경 없음
// =============================================================================

import { Server } from '@modelcontextprotocol/sdk/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../config';
import { PMatrixHttpClient } from '../client';
import { handleStatusTool } from './tools/status';
import { handleGradeTool } from './tools/grade';
import { handleHaltTool } from './tools/halt';

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'pmatrix_status',
    description:
      'Show current P-MATRIX safety grade, R(t) risk score, mode, and session counters for this Gemini CLI session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description:
            'Session ID to query (optional — defaults to most recently active session)',
        },
      },
    },
  },
  {
    name: 'pmatrix_grade',
    description:
      'Show behavioral trust grade and recent grade history for this P-MATRIX agent. Includes P-score, expiry, and dashboard link.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pmatrix_halt',
    description:
      '⛔ HALT — immediately block all tool execution across all Gemini CLI sessions. Creates ~/.pmatrix/HALT. To resume: rm ~/.pmatrix/HALT',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional reason for the halt (logged to HALT file)',
        },
      },
    },
  },
];

// ─── Server ───────────────────────────────────────────────────────────────────

export async function runMcpServer(): Promise<void> {
  const config = loadConfig();
  const client = new PMatrixHttpClient(config);

  const server = new Server(
    // TODO: version should be read dynamically from package.json;
    // deferred because dynamic import of JSON adds bundling complexity.
    { name: 'pmatrix', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Call tool — return cast to CallToolResult to satisfy SDK's union return type
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, unknown>;

    switch (name) {
      case 'pmatrix_status':
        return (await handleStatusTool(safeArgs, config, client)) as CallToolResult;

      case 'pmatrix_grade':
        return (await handleGradeTool(safeArgs, config, client)) as CallToolResult;

      case 'pmatrix_halt':
        return (await handleHaltTool(safeArgs, config, client)) as CallToolResult;

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
