// =============================================================================
// after-tool.test.ts — Gemini AfterTool hook 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. toolCallCount 증가 (정상 완료 기준)
//   2. tool_response 키 수 관찰 (내용 미접근, privacy-first)
//   3. mcp_context 존재 여부 → is_mcp 플래그
//   4. error/errorMessage 필드 → success=false
//   5. signal sendSignal 호출 (fire-and-forget)
//   6. saveState 호출
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpHome: string;
jest.mock('os', () => {
  const real = jest.requireActual<typeof import('os')>('os');
  return { ...real, homedir: jest.fn(() => tmpHome) };
});

import { handleAfterTool } from '../hooks/after-tool';
import { saveState, createDefaultState, loadState } from '../state-store';
import { PMatrixHttpClient } from '../client';
import type { PMatrixConfig } from '../types';
import type { GeminiAfterToolInput } from '../gemini-types';

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pmatrix-at-'));
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'after-agent',
    apiKey: 'test-key',
    safetyGate: { enabled: true, serverTimeoutMs: 2_500 },
    credentialProtection: { enabled: true, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75 },
    dataSharing: false,
    batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 },
    debug: false,
    ...overrides,
  };
}

function makeClient(): PMatrixHttpClient {
  const c = new PMatrixHttpClient(makeConfig());
  jest.spyOn(c, 'sendSignal').mockResolvedValue({ received: 1 });
  return c;
}

function makeEvent(overrides: Partial<GeminiAfterToolInput> = {}): GeminiAfterToolInput {
  return {
    session_id: 'sess-at',
    transcript_path: '/tmp/t',
    cwd: '/tmp',
    hook_event_name: 'AfterTool',
    timestamp: new Date().toISOString(),
    tool_name: 'read_file',
    tool_input: { path: '/tmp/x' },
    tool_response: { content: '...', size: 42 },
    ...overrides,
  };
}

// =============================================================================
// 1. toolCallCount 증가
// =============================================================================

describe('handleAfterTool — toolCallCount', () => {
  test('1회 호출 → toolCallCount=1', async () => {
    const client = makeClient();
    await handleAfterTool(makeEvent(), makeConfig(), client);

    const s = loadState('sess-at');
    expect(s).not.toBeNull();
    expect(s!.toolCallCount).toBe(1);
  });

  test('3회 호출 → toolCallCount=3', async () => {
    const client = makeClient();
    const cfg = makeConfig();
    await handleAfterTool(makeEvent(), cfg, client);
    await handleAfterTool(makeEvent(), cfg, client);
    await handleAfterTool(makeEvent(), cfg, client);

    const s = loadState('sess-at');
    expect(s!.toolCallCount).toBe(3);
  });
});

// =============================================================================
// 2. tool_response 키 수 관찰
// =============================================================================

describe('handleAfterTool — tool_response 관찰', () => {
  test('signal payload에 response_key_count 포함', async () => {
    const client = makeClient();
    const sendSpy = jest.spyOn(client, 'sendSignal').mockResolvedValue({ received: 1 });

    await handleAfterTool(
      makeEvent({ tool_response: { a: 1, b: 2, c: 3 } }),
      makeConfig(),
      client
    );

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = sendSpy.mock.calls[0]![0];
    expect(payload.metadata['response_key_count']).toBe(3);
  });

  test('tool_response null/undefined → response_key_count=0', async () => {
    const client = makeClient();
    const sendSpy = jest.spyOn(client, 'sendSignal').mockResolvedValue({ received: 1 });

    await handleAfterTool(
      { ...makeEvent(), tool_response: null as any },
      makeConfig(),
      client
    );

    const payload = sendSpy.mock.calls[0]![0];
    expect(payload.metadata['response_key_count']).toBe(0);
  });
});

// =============================================================================
// 3. mcp_context → is_mcp
// =============================================================================

describe('handleAfterTool — is_mcp', () => {
  test('mcp_context 있음 → is_mcp=true', async () => {
    const client = makeClient();
    const sendSpy = jest.spyOn(client, 'sendSignal').mockResolvedValue({ received: 1 });

    await handleAfterTool(
      makeEvent({
        mcp_context: { server_name: 'mysrv', tool_name: 'mytool' },
      }),
      makeConfig(),
      client
    );

    const payload = sendSpy.mock.calls[0]![0];
    expect(payload.metadata['is_mcp']).toBe(true);
  });

  test('mcp_context 없음 → is_mcp=false', async () => {
    const client = makeClient();
    const sendSpy = jest.spyOn(client, 'sendSignal').mockResolvedValue({ received: 1 });

    await handleAfterTool(makeEvent(), makeConfig(), client);

    const payload = sendSpy.mock.calls[0]![0];
    expect(payload.metadata['is_mcp']).toBe(false);
  });
});

// =============================================================================
// 4. success / error 추론
// =============================================================================

describe('handleAfterTool — success 추론', () => {
  test('error 필드 있음 → success=false', async () => {
    const client = makeClient();
    const sendSpy = jest.spyOn(client, 'sendSignal').mockResolvedValue({ received: 1 });

    await handleAfterTool(
      makeEvent({ tool_response: { error: 'ENOENT' } }),
      makeConfig(),
      client
    );

    const payload = sendSpy.mock.calls[0]![0];
    expect(payload.metadata['success']).toBe(false);
  });

  test('errorMessage 필드 있음 → success=false', async () => {
    const client = makeClient();
    const sendSpy = jest.spyOn(client, 'sendSignal').mockResolvedValue({ received: 1 });

    await handleAfterTool(
      makeEvent({ tool_response: { errorMessage: 'failed' } }),
      makeConfig(),
      client
    );

    expect(sendSpy.mock.calls[0]![0].metadata['success']).toBe(false);
  });

  test('error 없음 → success=true', async () => {
    const client = makeClient();
    const sendSpy = jest.spyOn(client, 'sendSignal').mockResolvedValue({ received: 1 });

    await handleAfterTool(
      makeEvent({ tool_response: { result: 'ok' } }),
      makeConfig(),
      client
    );

    expect(sendSpy.mock.calls[0]![0].metadata['success']).toBe(true);
  });
});

// =============================================================================
// 5. 반환값 — 빈 객체
// =============================================================================

describe('handleAfterTool — 반환값', () => {
  test('항상 {} 반환 (관찰만, 차단 없음)', async () => {
    const r = await handleAfterTool(makeEvent(), makeConfig(), makeClient());
    expect(r).toEqual({});
  });
});
