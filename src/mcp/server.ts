// =============================================================================
// @pmatrix/gemini-cli-monitor — mcp/server.ts
// P-MATRIX MCP stdio server
//
// Exposes 4 MCP tools:
//   pmatrix_status       — R(t)/Grade/Mode/session counters
//   pmatrix_grade        — trust grade + history + dashboard link
//   pmatrix_halt         — global Kill Switch (creates ~/.pmatrix/HALT)
//   pmatrix_field_status — 4.0 Field connection status (Phase 6)
//
// Started by: pmatrix-gemini mcp
// Transport:  stdio (Gemini CLI MCP protocol)
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
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
import {
  FieldNode,
  isField4Enabled,
  buildFieldConfigFromEnv,
  readFieldState,
  getFieldSessionsDir,
} from '@pmatrix/field-node-runtime';

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
  {
    name: 'pmatrix_field_status',
    description:
      'Show 4.0 Field connection status, peer count, and local posture.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ─── Field IPC Poller ─────────────────────────────────────────────────────────

const FIELD_POLL_INTERVAL_MS = 5_000;

function findLatestFieldSession(): string | null {
  try {
    const dir = getFieldSessionsDir();
    if (!fs.existsSync(dir)) return null;

    const entries = fs.readdirSync(dir)
      .filter(f => f.startsWith('field-') && f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => ({
        name: f,
        key: f.slice('field-'.length, -'.json'.length),
        mtime: fs.statSync(path.join(dir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    return entries[0]?.key ?? null;
  } catch {
    return null;
  }
}

function startFieldPoller(fieldNode: FieldNode): void {
  let lastUpdatedAt = '';

  setInterval(() => {
    try {
      const sessionKey = findLatestFieldSession();
      if (!sessionKey) return;

      const state = readFieldState(sessionKey);
      if (!state || state.updatedAt === lastUpdatedAt) return;
      lastUpdatedAt = state.updatedAt;

      if (state.axes) {
        fieldNode.sendStateVector({
          baseline: state.axes.baseline,
          norm: state.axes.norm,
          stability: state.axes.stability,
          meta_control: state.axes.meta_control,
          loopCount: state.totalTurns,
          currentMode: state.currentMode,
        });
      } else if (state.currentRt !== undefined) {
        // Degraded SV: Gemini 3.5 설계상 개별 축 값 미보유
        // neutral axes + degraded 플래그. Peer Decider는 r_t만 사용.
        fieldNode.sendStateVector({
          baseline: 0.5,
          norm: 0.5,
          stability: 0.5,
          meta_control: 0.5,
          loopCount: state.totalTurns,
          currentMode: state.currentMode,
          degraded: true,
        });
      }
    } catch {
      // Fail-open
    }
  }, FIELD_POLL_INTERVAL_MS);
}

// ─── Server ───────────────────────────────────────────────────────────────────

export async function runMcpServer(): Promise<void> {
  const config = loadConfig();
  const client = new PMatrixHttpClient(config);

  // ── 4.0 Field Node (MCP persistent process) ─────────────────────────────
  let fieldNode: FieldNode | null = null;
  if (isField4Enabled()) {
    try {
      const fc = buildFieldConfigFromEnv(config.serverUrl, config.apiKey);
      if (fc) {
        fieldNode = new FieldNode(fc);
        fieldNode.start();
      }
    } catch {
      // Fail-open: Field 초기화 실패해도 3.5 MCP 서버 정상 동작
    }
  }

  const server = new Server(
    // MCP server implementation version — keep in sync with package.json
    { name: 'pmatrix', version: '0.2.0' },
    { capabilities: { tools: {} } }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Call tool
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

      case 'pmatrix_field_status': {
        const status = {
          connected: fieldNode?.isConnected ?? false,
          peerCount: fieldNode?.peerCount ?? 0,
          myPosture: 'maintain',
          fieldId: fieldNode?.fieldId ?? '',
        };
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(status, null, 2),
          }],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (fieldNode) {
    startFieldPoller(fieldNode);
  }

  const shutdown = async () => {
    await fieldNode?.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
