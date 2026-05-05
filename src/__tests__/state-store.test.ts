// =============================================================================
// state-store.test.ts — file-based session state CRUD 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. createDefaultState — 기본 필드 / 카운터 0 초기화 / framework='gemini_cli'
//   2. loadOrCreateState — 신규 세션 / 백필 / 손상된 파일 → fail-open
//   3. saveState / loadState — round-trip 정합
//   4. deleteState — 삭제 + 미존재 fail-open
//   5. R(t) 캐시 helpers — buildRtCacheExpiry / isRtCacheValid
//   6. HALT 파일 — isHaltActive / activateHalt
//   7. findActiveSession — framework filter / 최근 세션 선택
//   8. cleanupStaleStates — 24시간 이상된 파일 삭제
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 격리된 임시 HOME — jest.mock으로 os.homedir 자체를 직전 cwd로 대체
let tmpHome: string;

jest.mock('os', () => {
  const real = jest.requireActual<typeof import('os')>('os');
  return {
    ...real,
    homedir: jest.fn(() => tmpHome),
  };
});

import {
  createDefaultState,
  loadOrCreateState,
  loadState,
  saveState,
  deleteState,
  buildRtCacheExpiry,
  isRtCacheValid,
  haltFilePath,
  isHaltActive,
  activateHalt,
  findActiveSession,
  cleanupStaleStates,
} from '../state-store';

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pmatrix-state-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore on Windows file-locked cases
  }
});

// =============================================================================
// 1. createDefaultState
// =============================================================================

describe('createDefaultState', () => {
  test('필수 필드 + 카운터 0 + framework=gemini_cli', () => {
    const s = createDefaultState('sess-1', 'agent-1');
    expect(s.sessionId).toBe('sess-1');
    expect(s.agentId).toBe('agent-1');
    expect(s.currentRt).toBe(0);
    expect(s.currentMode).toBe('normal');
    expect(s.grade).toBeNull();
    expect(s.isHalted).toBe(false);
    expect(s.framework).toBe('gemini_cli');

    expect(s.dangerEvents).toBe(0);
    expect(s.credentialBlocks).toBe(0);
    expect(s.safetyGateBlocks).toBe(0);
    expect(s.totalTurns).toBe(0);
    expect(s.permissionRequestCount).toBe(0);

    expect(s.llmCallCount).toBe(0);
    expect(s.totalTokens).toBe(0);
    expect(s.promptTurnCount).toBe(0);
    expect(s.credentialBlockCount).toBe(0);
    expect(s.compactCount).toBe(0);
    expect(s.policyDenyCount).toBe(0);
    expect(s.safetyFlagCount).toBe(0);
    expect(s.toolDenyCount).toBe(0);
    expect(s.toolCallCount).toBe(0);

    expect(() => new Date(s.startedAt).toISOString()).not.toThrow();
    expect(() => new Date(s.updatedAt).toISOString()).not.toThrow();
  });

  test('rtCacheExpiry 즉시 만료 (isRtCacheValid=false)', () => {
    const s = createDefaultState('sess-x', 'agent-x');
    expect(isRtCacheValid(s)).toBe(false);
  });
});

// =============================================================================
// 2. loadOrCreateState — fail-open + backfill
// =============================================================================

describe('loadOrCreateState', () => {
  test('신규 세션 → default state 반환', () => {
    const s = loadOrCreateState('new-session', 'a-1');
    expect(s.sessionId).toBe('new-session');
    expect(s.agentId).toBe('a-1');
    expect(s.totalTurns).toBe(0);
  });

  test('손상된 JSON → fail-open default state', () => {
    saveState(createDefaultState('corrupt-test', 'a-1'));
    const stateFile = path.join(tmpHome, '.pmatrix', 'sessions', 'corrupt-test.json');
    fs.writeFileSync(stateFile, '{ this is not json', 'utf-8');

    // suppress stderr noise
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const s = loadOrCreateState('corrupt-test', 'a-1');
    expect(s.sessionId).toBe('corrupt-test');
    expect(s.totalTurns).toBe(0);
  });

  test('legacy state 백필 — 누락 필드는 0/빈문자열로 초기화', () => {
    const dir = path.join(tmpHome, '.pmatrix', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const legacy = {
      sessionId: 'legacy',
      agentId: 'a-1',
      startedAt: new Date().toISOString(),
      currentRt: 0.1,
      currentMode: 'normal' as const,
      grade: null,
      rtCacheExpiry: new Date().toISOString(),
      isHalted: false,
      dangerEvents: 0,
      credentialBlocks: 0,
      safetyGateBlocks: 0,
      totalTurns: 5,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'legacy.json'), JSON.stringify(legacy), 'utf-8');

    const s = loadOrCreateState('legacy', 'a-1');
    expect(s.totalTurns).toBe(5);
    expect(s.permissionRequestCount).toBe(0);
    expect(s.framework).toBe('gemini_cli');
    expect(s.llmCallCount).toBe(0);
    expect(s.policyDenyCount).toBe(0);
  });
});

// =============================================================================
// 3. saveState / loadState — round-trip
// =============================================================================

describe('saveState / loadState — round-trip', () => {
  test('저장 후 로드 → 동일 state', () => {
    const s = createDefaultState('rt-1', 'a-1');
    s.totalTurns = 7;
    s.currentRt = 0.42;
    s.toolCallCount = 3;
    saveState(s);

    const loaded = loadState('rt-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.totalTurns).toBe(7);
    expect(loaded!.currentRt).toBe(0.42);
    expect(loaded!.toolCallCount).toBe(3);
  });

  test('미존재 세션 → null', () => {
    expect(loadState('does-not-exist')).toBeNull();
  });

  test('saveState 후 updatedAt 갱신됨', async () => {
    const s = createDefaultState('upd-1', 'a-1');
    const orig = s.updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    saveState(s);
    expect(s.updatedAt).not.toBe(orig);
  });
});

// =============================================================================
// 4. deleteState
// =============================================================================

describe('deleteState', () => {
  test('저장된 파일 삭제', () => {
    const s = createDefaultState('del-1', 'a-1');
    saveState(s);
    expect(loadState('del-1')).not.toBeNull();

    deleteState('del-1');
    expect(loadState('del-1')).toBeNull();
  });

  test('미존재 세션 삭제 → 에러 없음 (fail-open)', () => {
    expect(() => deleteState('never-existed')).not.toThrow();
  });
});

// =============================================================================
// 5. R(t) 캐시
// =============================================================================

describe('R(t) cache helpers', () => {
  test('buildRtCacheExpiry → 미래 ISO', () => {
    const exp = buildRtCacheExpiry();
    const expMs = new Date(exp).getTime();
    expect(expMs).toBeGreaterThan(Date.now());
  });

  test('갓 만든 expiry → isRtCacheValid=true', () => {
    const s = createDefaultState('cache', 'a-1');
    s.rtCacheExpiry = buildRtCacheExpiry();
    expect(isRtCacheValid(s)).toBe(true);
  });

  test('과거 expiry → isRtCacheValid=false', () => {
    const s = createDefaultState('cache', 'a-1');
    s.rtCacheExpiry = new Date(Date.now() - 1_000).toISOString();
    expect(isRtCacheValid(s)).toBe(false);
  });
});

// =============================================================================
// 6. HALT file
// =============================================================================

describe('HALT file', () => {
  test('initial — 미존재 → false', () => {
    expect(isHaltActive()).toBe(false);
  });

  test('activateHalt → isHaltActive=true', () => {
    activateHalt('manual test');
    expect(isHaltActive()).toBe(true);

    const haltPath = haltFilePath();
    expect(fs.existsSync(haltPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(haltPath, 'utf-8'));
    expect(content.reason).toBe('manual test');
    expect(content.activatedAt).toBeDefined();
  });

  test('haltFilePath() → ~/.pmatrix/HALT', () => {
    const p = haltFilePath();
    expect(p).toContain('.pmatrix');
    expect(p.endsWith('HALT')).toBe(true);
  });
});

// =============================================================================
// 7. findActiveSession
// =============================================================================

describe('findActiveSession', () => {
  test('빈 디렉토리 → null', () => {
    expect(findActiveSession('gemini_cli')).toBeNull();
  });

  test('가장 최근 업데이트된 세션 반환', async () => {
    const a = createDefaultState('a', 'agent');
    saveState(a);
    await new Promise((r) => setTimeout(r, 10));
    const b = createDefaultState('b', 'agent');
    saveState(b);

    const found = findActiveSession('gemini_cli');
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe('b');
  });

  test('framework filter — 다른 framework 제외', () => {
    const g = createDefaultState('g-1', 'agent');
    saveState(g);
    const dir = path.join(tmpHome, '.pmatrix', 'sessions');
    const cursorState = {
      ...g,
      sessionId: 'c-1',
      framework: 'cursor',
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'c-1.json'), JSON.stringify(cursorState), 'utf-8');

    const found = findActiveSession('gemini_cli');
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe('g-1');
  });
});

// =============================================================================
// 8. cleanupStaleStates
// =============================================================================

describe('cleanupStaleStates', () => {
  test('24시간 이내 파일 → 보존', () => {
    const s = createDefaultState('fresh', 'a');
    saveState(s);
    cleanupStaleStates();
    expect(loadState('fresh')).not.toBeNull();
  });

  test('.tmp 파일 → 즉시 삭제', () => {
    const dir = path.join(tmpHome, '.pmatrix', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const tmpFile = path.join(dir, 'leftover.json.tmp');
    fs.writeFileSync(tmpFile, '{}', 'utf-8');
    cleanupStaleStates();
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  test('미존재 디렉토리 → fail-open (에러 없음)', () => {
    expect(() => cleanupStaleStates()).not.toThrow();
  });
});
