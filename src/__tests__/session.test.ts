// =============================================================================
// session.test.ts — Gemini SessionStart / SessionEnd hooks 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. handleSessionStart — session_id 누락 fail-open
//   2. handleSessionStart — sessionSource / workspaceRoot 저장
//   3. handleSessionStart — dataSharing=true → sendCritical 1회
//   4. handleSessionStart — saveState 호출
//   5. handleSessionEnd — sendSessionSummary + deleteState
//   6. handleSessionEnd — dataSharing=false → 신호 미전송
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpHome: string;
jest.mock('os', () => {
  const real = jest.requireActual<typeof import('os')>('os');
  return { ...real, homedir: jest.fn(() => tmpHome) };
});

import { handleSessionStart, handleSessionEnd } from '../hooks/session';
import { loadState, createDefaultState, saveState } from '../state-store';
import { PMatrixHttpClient } from '../client';
import type { PMatrixConfig } from '../types';
import type { GeminiSessionStartInput, GeminiSessionEndInput } from '../gemini-types';

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pmatrix-sess-'));
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'sess-agent',
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
  jest.spyOn(c, 'sendCritical').mockResolvedValue();
  jest.spyOn(c, 'sendSessionSummary').mockResolvedValue();
  jest.spyOn(c, 'resubmitUnsent').mockResolvedValue();
  return c;
}

function makeStartEvent(overrides: Partial<GeminiSessionStartInput> = {}): GeminiSessionStartInput {
  return {
    session_id: 'sess-start-1',
    transcript_path: '/tmp/t',
    cwd: '/workspace',
    hook_event_name: 'SessionStart',
    timestamp: new Date().toISOString(),
    source: 'startup',
    ...overrides,
  };
}

function makeEndEvent(overrides: Partial<GeminiSessionEndInput> = {}): GeminiSessionEndInput {
  return {
    session_id: 'sess-end-1',
    transcript_path: '/tmp/t',
    cwd: '/workspace',
    hook_event_name: 'SessionEnd',
    timestamp: new Date().toISOString(),
    reason: 'exit',
    ...overrides,
  };
}

// =============================================================================
// 1. handleSessionStart — session_id 누락
// =============================================================================

describe('handleSessionStart — session_id 방어', () => {
  test('session_id 없음 → 상태 미생성, 에러 없음', async () => {
    const ev = makeStartEvent();
    delete (ev as any).session_id;

    await expect(
      handleSessionStart(ev, makeConfig(), makeClient())
    ).resolves.toBeUndefined();
  });

  test('session_id=number → fail-open (string 아님)', async () => {
    const ev = makeStartEvent();
    (ev as any).session_id = 123;

    await expect(
      handleSessionStart(ev, makeConfig(), makeClient())
    ).resolves.toBeUndefined();
  });
});

// =============================================================================
// 2. handleSessionStart — 메타데이터 저장
// =============================================================================

describe('handleSessionStart — 메타데이터 저장', () => {
  test('sessionSource + workspaceRoot 저장됨', async () => {
    await handleSessionStart(
      makeStartEvent({ session_id: 'meta-1', source: 'resume', cwd: '/my/project' }),
      makeConfig(),
      makeClient()
    );

    const s = loadState('meta-1');
    expect(s).not.toBeNull();
    expect(s!.sessionSource).toBe('resume');
    // GEMINI_PROJECT_DIR 미설정 시 cwd 사용
    expect(s!.workspaceRoot).toBe('/my/project');
  });

  test('GEMINI_PROJECT_DIR 우선', async () => {
    process.env['GEMINI_PROJECT_DIR'] = '/explicit/dir';
    try {
      await handleSessionStart(
        makeStartEvent({ session_id: 'meta-2', cwd: '/cwd/dir' }),
        makeConfig(),
        makeClient()
      );

      const s = loadState('meta-2');
      expect(s!.workspaceRoot).toBe('/explicit/dir');
    } finally {
      delete process.env['GEMINI_PROJECT_DIR'];
    }
  });

  test('framework=gemini_cli', async () => {
    await handleSessionStart(
      makeStartEvent({ session_id: 'fw-1' }),
      makeConfig(),
      makeClient()
    );

    const s = loadState('fw-1');
    expect(s!.framework).toBe('gemini_cli');
  });
});

// =============================================================================
// 3. handleSessionStart — dataSharing
// =============================================================================

describe('handleSessionStart — dataSharing', () => {
  test('dataSharing=true → sendCritical 1회 (session_start signal)', async () => {
    const client = makeClient();
    const spy = jest.spyOn(client, 'sendCritical').mockResolvedValue();

    await handleSessionStart(
      makeStartEvent({ session_id: 'ds-1' }),
      makeConfig({ dataSharing: true }),
      client
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const sig = spy.mock.calls[0]![0];
    expect(sig.metadata['event_type']).toBe('session_start');
    expect(sig.signal_source).toBe('gemini_cli_hook');
    expect(sig.framework).toBe('gemini_cli');
  });

  test('dataSharing=false → sendCritical 미호출', async () => {
    const client = makeClient();
    const spy = jest.spyOn(client, 'sendCritical').mockResolvedValue();

    await handleSessionStart(
      makeStartEvent({ session_id: 'ds-0' }),
      makeConfig({ dataSharing: false }),
      client
    );

    expect(spy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 4. handleSessionEnd — sendSessionSummary
// =============================================================================

describe('handleSessionEnd', () => {
  test('dataSharing=true → sendSessionSummary 호출 + deleteState', async () => {
    // 사전 상태
    const s = createDefaultState('end-1', 'sess-agent');
    s.promptTurnCount = 5;
    s.dangerEvents = 1;
    saveState(s);

    const client = makeClient();
    const summarySpy = jest.spyOn(client, 'sendSessionSummary').mockResolvedValue();

    await handleSessionEnd(
      makeEndEvent({ session_id: 'end-1', reason: 'exit' }),
      makeConfig({ dataSharing: true }),
      client
    );

    expect(summarySpy).toHaveBeenCalledTimes(1);
    const arg = summarySpy.mock.calls[0]![0];
    expect(arg.sessionId).toBe('end-1');
    expect(arg.totalTurns).toBe(5);
    expect(arg.dangerEvents).toBe(1);
    expect(arg.endReason).toBe('exit');
    // R-X.3 migration: signal_source + framework flow via AdapterIdentity
    // at client construction. Equivalent coverage in contract.test.ts.

    // state 삭제됨
    expect(loadState('end-1')).toBeNull();
  });

  test('dataSharing=false → sendSessionSummary 미호출, 그래도 deleteState', async () => {
    const s = createDefaultState('end-2', 'sess-agent');
    saveState(s);

    const client = makeClient();
    const summarySpy = jest.spyOn(client, 'sendSessionSummary').mockResolvedValue();

    await handleSessionEnd(
      makeEndEvent({ session_id: 'end-2' }),
      makeConfig({ dataSharing: false }),
      client
    );

    expect(summarySpy).not.toHaveBeenCalled();
    expect(loadState('end-2')).toBeNull();
  });

  test('reason 다양 (clear/logout/...) → endReason 전달', async () => {
    const s = createDefaultState('end-3', 'sess-agent');
    saveState(s);

    const client = makeClient();
    const summarySpy = jest.spyOn(client, 'sendSessionSummary').mockResolvedValue();

    await handleSessionEnd(
      makeEndEvent({ session_id: 'end-3', reason: 'logout' }),
      makeConfig({ dataSharing: true }),
      client
    );

    expect(summarySpy.mock.calls[0]![0].endReason).toBe('logout');
  });
});
