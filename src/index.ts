#!/usr/bin/env node
// =============================================================================
// @pmatrix/gemini-cli-monitor — index.ts
// pmatrix-gemini CLI entry point
//
// Sprint 1: session-start, session-end, before-agent
// Sprint 2: before-tool (Safety Gate) + setup trustedFolders 안내
// Sprint 3: before-model, after-model (LLM 메타데이터 관측) ✓
// Sprint 4: after-tool, after-agent, before-tool-selection, pre-compress, notification ✓
// Sprint 5: MCP server + Setup CLI (full) ✓
//
// 서브커맨드: session-start | session-end | before-agent
//             before-tool | after-tool | after-agent
//             before-model | after-model
//             before-tool-selection | pre-compress | notification
//             mcp | setup
// stdin:     Gemini CLI hook JSON
// stdout:    Gemini hook response JSON (blocking 훅만 — fail-open)
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from './config';
import { PMatrixHttpClient } from './client';
import {
  GeminiSessionStartInput,
  GeminiSessionEndInput,
  GeminiBeforeAgentInput,
  GeminiBeforeToolInput,
} from './gemini-types';
import { handleSessionStart, handleSessionEnd } from './hooks/session';
import { handleBeforeAgent } from './hooks/before-agent';
import { handleBeforeTool } from './hooks/before-tool';
import { handleBeforeModel } from './hooks/before-model';
import { handleAfterModel } from './hooks/after-model';
import { handleAfterTool } from './hooks/after-tool';
import { handleAfterAgent } from './hooks/after-agent';
import { handleBeforeToolSelection } from './hooks/before-tool-selection';
import { handlePreCompress } from './hooks/pre-compress';
import { handleNotification } from './hooks/notification';
import {
  GeminiBeforeModelInput,
  GeminiAfterModelInput,
  GeminiAfterToolInput,
  GeminiAfterAgentInput,
  GeminiBeforeToolSelectionInput,
  GeminiPreCompressInput,
  GeminiNotificationInput,
} from './gemini-types';

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  // MCP server — persistent stdio process for Gemini CLI MCP integration
  if (subcommand === 'mcp') {
    const { runMcpServer } = await import('./mcp/server.js');
    await runMcpServer();
    return;
  }

  // Setup command — guidance only (⚠️ NO auto-write to settings.json)
  if (subcommand === 'setup') {
    handleSetup();
    process.exit(0); return;
  }

  const rawInput = await readStdin();
  if (!rawInput.trim()) { process.exit(0); return; }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawInput) as Record<string, unknown>;
  } catch {
    // stdin parse error — fail-open
    process.exit(0); return;
  }

  const config = loadConfig();
  if (!config.agentId || !config.apiKey) {
    // 미설정 상태 — 신호 전송 건너뜀, exit 0
    process.exit(0); return;
  }
  const client = new PMatrixHttpClient(config);

  // 서브커맨드 우선, 없으면 hook_event_name fallback
  const hookName = subcommand ?? (event['hook_event_name'] as string | undefined);

  try {
    switch (hookName) {
      // ── Sprint 1: 세션 + Credential ────────────────────────────────────────

      case 'session-start':
      case 'SessionStart':
        await handleSessionStart(event as unknown as GeminiSessionStartInput, config, client);
        break;

      case 'session-end':
      case 'SessionEnd':
        await handleSessionEnd(event as unknown as GeminiSessionEndInput, config, client);
        break;

      case 'before-agent':
      case 'BeforeAgent': {
        const output = await handleBeforeAgent(
          event as unknown as GeminiBeforeAgentInput,
          config,
          client
        );
        // stdout JSON 이스케이핑 — Gemini CLI는 stdout을 JSON 파싱
        process.stdout.write(JSON.stringify(output) + '\n');
        break;
      }

      // ── Sprint 2: Safety Gate ──────────────────────────────────────────────

      case 'before-tool':
      case 'BeforeTool': {
        const output = await handleBeforeTool(
          event as unknown as GeminiBeforeToolInput,
          config,
          client
        );
        process.stdout.write(JSON.stringify(output) + '\n');
        break;
      }

      // ── Sprint 3: LLM 메타데이터 관측 ────────────────────────────────────

      case 'before-model':
      case 'BeforeModel': {
        // 관찰만 — stdout 불필요, 하지만 빈 JSON 출력으로 Gemini CLI 기대 충족
        await handleBeforeModel(
          event as unknown as GeminiBeforeModelInput,
          config,
          client
        );
        break;
      }

      case 'after-model':
      case 'AfterModel': {
        // 스트리밍 청크: finishReason 없으면 내부에서 즉시 return {}
        await handleAfterModel(
          event as unknown as GeminiAfterModelInput,
          config,
          client
        );
        break;
      }

      // ── Sprint 4: 관찰 훅 5종 ────────────────────────────────────────────

      case 'after-tool':
      case 'AfterTool':
        await handleAfterTool(
          event as unknown as GeminiAfterToolInput,
          config, client
        );
        break;

      case 'after-agent':
      case 'AfterAgent':
        await handleAfterAgent(
          event as unknown as GeminiAfterAgentInput,
          config, client
        );
        break;

      case 'before-tool-selection':
      case 'BeforeToolSelection':
        await handleBeforeToolSelection(
          event as unknown as GeminiBeforeToolSelectionInput,
          config, client
        );
        break;

      case 'pre-compress':
      case 'PreCompress':
        await handlePreCompress(
          event as unknown as GeminiPreCompressInput,
          config, client
        );
        break;

      case 'notification':
      case 'Notification':
        await handleNotification(
          event as unknown as GeminiNotificationInput,
          config, client
        );
        break;

      default:
        // 미등록 훅 — fail-open
        break;
    }
    process.exit(0);
  } catch {
    // 모든 예외 — fail-open
    process.exit(0);
  }
}

/**
 * Setup — guidance only
 *
 * ⚠️ settings.json 자동 수정 금지 — 안내만 출력, 사용자가 직접 붙여넣기
 *
 * L-5 검증에서 확인된 사항:
 *   - 작업 폴더가 trustedFolders에 없으면 훅이 실행되지 않음
 *   - 반드시 해당 폴더에서 `gemini` 실행 후 신뢰 허용을 먼저 수행해야 함
 */
function handleSetup(): void {
  const cwd = process.cwd();
  const trustedPath = path.join(os.homedir(), '.gemini', 'trustedFolders.json');
  const settingsPath = path.join(os.homedir(), '.gemini', 'settings.json');

  // Parse optional --agent-id / --api-key flags
  const args = process.argv.slice(3);
  const agentId = getFlag(args, '--agent-id');
  const apiKey  = getFlag(args, '--api-key');

  // Persist config flags if provided
  if (agentId || apiKey) {
    updatePMatrixConfig({ agentId, apiKey });
  }

  process.stdout.write('\n[P-MATRIX] Gemini CLI Monitor — Setup\n');
  process.stdout.write('─'.repeat(56) + '\n');

  // ── 1. Trust status ──────────────────────────────────────────────────────────
  let isTrusted = false;
  try {
    if (fs.existsSync(trustedPath)) {
      const raw = fs.readFileSync(trustedPath, 'utf-8');
      const data = JSON.parse(raw) as unknown;
      const folders: string[] = Array.isArray(data)
        ? (data as string[])
        : ((data as Record<string, unknown>)['trustedFolders'] as string[] | undefined) ?? [];
      isTrusted = folders.some((f) => cwd.startsWith(f) || cwd === f);
    }
  } catch {
    // fail-open
  }

  if (isTrusted) {
    process.stdout.write(`✓ Trust status : TRUSTED\n`);
    process.stdout.write(`  Folder: ${cwd}\n`);
  } else {
    process.stdout.write(`⚠ Trust status : NOT TRUSTED\n`);
    process.stdout.write(`  Folder: ${cwd}\n`);
    process.stdout.write(`  Hooks will NOT run until this folder is trusted.\n`);
    process.stdout.write(`  Fix: run 'gemini' in this folder and accept the trust prompt.\n`);
  }

  // ── 2. Hooks config block ────────────────────────────────────────────────────
  const hooksBlock = buildHooksBlock();
  process.stdout.write('\n');
  process.stdout.write(`Hooks config — add to ${settingsPath} :\n`);
  process.stdout.write('─'.repeat(56) + '\n');
  process.stdout.write(hooksBlock + '\n');
  process.stdout.write('─'.repeat(56) + '\n');

  // ── 3. MCP config block ──────────────────────────────────────────────────────
  const mcpBlock = JSON.stringify({
    mcpServers: {
      pmatrix: {
        command: 'pmatrix-gemini',
        args: ['mcp'],
        env: { PMATRIX_API_KEY: '${env:PMATRIX_API_KEY}' },
      },
    },
  }, null, 2);
  process.stdout.write('\n');
  process.stdout.write(`MCP config — add to ${settingsPath} :\n`);
  process.stdout.write('─'.repeat(56) + '\n');
  process.stdout.write(mcpBlock + '\n');
  process.stdout.write('─'.repeat(56) + '\n');

  // ── 4. Next steps ────────────────────────────────────────────────────────────
  process.stdout.write('\n');
  if (!agentId) {
    process.stdout.write('Next: set your Agent ID\n');
    process.stdout.write('  pmatrix-gemini setup --agent-id <YOUR_AGENT_ID>\n');
    process.stdout.write('  or: export PMATRIX_AGENT_ID=<id>\n');
    process.stdout.write('\n');
  }
  if (!apiKey) {
    process.stdout.write('Next: set your API key\n');
    process.stdout.write('  export PMATRIX_API_KEY=<YOUR_API_KEY>\n');
    process.stdout.write('\n');
  }
  process.stdout.write('Restart Gemini CLI to activate monitoring.\n');
  process.stdout.write('Dashboard: https://app.pmatrix.io\n');
  process.stdout.write('\n');
}

function buildHooksBlock(): string {
  const hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>> = {
    SessionStart:         [{ hooks: [{ command: 'pmatrix-gemini session-start' }] }],
    SessionEnd:           [{ hooks: [{ command: 'pmatrix-gemini session-end' }] }],
    BeforeAgent:          [{ hooks: [{ command: 'pmatrix-gemini before-agent', timeout: 5 }] }],
    BeforeTool:           [{ hooks: [{ command: 'pmatrix-gemini before-tool',  timeout: 5 }] }],
    AfterTool:            [{ hooks: [{ command: 'pmatrix-gemini after-tool' }] }],
    BeforeModel:          [{ hooks: [{ command: 'pmatrix-gemini before-model' }] }],
    AfterModel:           [{ hooks: [{ command: 'pmatrix-gemini after-model' }] }],
    AfterAgent:           [{ hooks: [{ command: 'pmatrix-gemini after-agent' }] }],
    BeforeToolSelection:  [{ hooks: [{ command: 'pmatrix-gemini before-tool-selection' }] }],
    PreCompress:          [{ hooks: [{ command: 'pmatrix-gemini pre-compress' }] }],
    Notification:         [{ hooks: [{ command: 'pmatrix-gemini notification' }] }],
  };
  return JSON.stringify({ hooks }, null, 2);
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function updatePMatrixConfig(updates: { agentId?: string; apiKey?: string }): void {
  const configPath = path.join(os.homedir(), '.pmatrix', 'config.json');
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    }
  } catch {
    // fail-open
  }

  if (updates.agentId) existing['agentId'] = updates.agentId;
  if (updates.apiKey)  existing['apiKey']  = updates.apiKey;

  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  process.stdout.write(`  Saved config: ${configPath}\n`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

main().catch(() => process.exit(0));
