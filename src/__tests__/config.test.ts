// =============================================================================
// config.test.ts — loadConfig 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. 기본값 — 파일 없음, env 없음 → DEFAULT_CONFIG
//   2. 파일 처리 — 부분 설정 / 손상된 JSON → fail-open
//   3. 환경변수 우선순위 — env > file > default
//   4. ${VAR} 환경변수 참조 치환 (apiKey)
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from '../config';

const tmpFiles: string[] = [];

function createTempConfig(content: object): string {
  const p = path.join(
    os.tmpdir(),
    `pmatrix-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(p, JSON.stringify(content), 'utf-8');
  tmpFiles.push(p);
  return p;
}

const envBackup: Record<string, string | undefined> = {};

function setEnv(k: string, v: string): void {
  if (!(k in envBackup)) envBackup[k] = process.env[k];
  process.env[k] = v;
}

function unsetEnv(k: string): void {
  if (!(k in envBackup)) envBackup[k] = process.env[k];
  delete process.env[k];
}

afterEach(() => {
  for (const [k, orig] of Object.entries(envBackup)) {
    if (orig === undefined) delete process.env[k];
    else process.env[k] = orig;
  }
  for (const k of Object.keys(envBackup)) delete envBackup[k];
});

afterAll(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

// =============================================================================
// 1. 기본값
// =============================================================================

describe('loadConfig — 기본값', () => {
  test('파일 없음 + env 없음 → DEFAULT_CONFIG', () => {
    unsetEnv('PMATRIX_API_KEY');
    unsetEnv('PMATRIX_SERVER_URL');
    unsetEnv('PMATRIX_AGENT_ID');
    unsetEnv('PMATRIX_DEBUG');

    const c = loadConfig('/non/existent/path.json');
    expect(c.serverUrl).toBe('https://api.pmatrix.io');
    expect(c.apiKey).toBe('');
    expect(c.agentId).toBe('');
    expect(c.debug).toBe(false);
    expect(c.dataSharing).toBe(false);
    expect(c.frameworkTag).toBe('stable');
    expect(c.safetyGate.enabled).toBe(true);
    expect(c.killSwitch.autoHaltOnRt).toBe(0.75);
    expect(c.batch.retryMax).toBe(3);
  });

  test('손상된 JSON → fail-open 기본값', () => {
    const p = path.join(os.tmpdir(), `pmatrix-corrupt-${Date.now()}.json`);
    fs.writeFileSync(p, '{ invalid json', 'utf-8');
    tmpFiles.push(p);

    unsetEnv('PMATRIX_API_KEY');
    const c = loadConfig(p);
    expect(c.serverUrl).toBe('https://api.pmatrix.io');
  });
});

// =============================================================================
// 2. 부분 설정 + 병합
// =============================================================================

describe('loadConfig — 부분 설정 + 병합', () => {
  test('agentId만 → 나머지는 기본값', () => {
    unsetEnv('PMATRIX_AGENT_ID');
    unsetEnv('PMATRIX_API_KEY');
    const p = createTempConfig({ agentId: 'my-agent' });

    const c = loadConfig(p);
    expect(c.agentId).toBe('my-agent');
    expect(c.serverUrl).toBe('https://api.pmatrix.io');
  });

  test('safetyGate.serverTimeoutMs override + 다른 필드 default', () => {
    unsetEnv('PMATRIX_API_KEY');
    const p = createTempConfig({ safetyGate: { serverTimeoutMs: 5_000 } });

    const c = loadConfig(p);
    expect(c.safetyGate.serverTimeoutMs).toBe(5_000);
    expect(c.safetyGate.enabled).toBe(true); // default 유지
  });

  test('batch override + 부분 필드 default', () => {
    const p = createTempConfig({ batch: { retryMax: 7 } });
    unsetEnv('PMATRIX_API_KEY');

    const c = loadConfig(p);
    expect(c.batch.retryMax).toBe(7);
    expect(c.batch.maxSize).toBe(10); // default
    expect(c.batch.flushIntervalMs).toBe(2_000);
  });
});

// =============================================================================
// 3. 환경변수 우선순위
// =============================================================================

describe('loadConfig — 환경변수 우선', () => {
  test('PMATRIX_API_KEY → file 무시', () => {
    setEnv('PMATRIX_API_KEY', 'env-key-123');
    const p = createTempConfig({ apiKey: 'file-key' });

    const c = loadConfig(p);
    expect(c.apiKey).toBe('env-key-123');
  });

  test('PMATRIX_SERVER_URL → file 무시', () => {
    setEnv('PMATRIX_SERVER_URL', 'https://staging.example.com');
    const p = createTempConfig({ serverUrl: 'https://prod.example.com' });

    const c = loadConfig(p);
    expect(c.serverUrl).toBe('https://staging.example.com');
  });

  test('PMATRIX_AGENT_ID → file 무시', () => {
    setEnv('PMATRIX_AGENT_ID', 'env-agent');
    const p = createTempConfig({ agentId: 'file-agent' });

    const c = loadConfig(p);
    expect(c.agentId).toBe('env-agent');
  });

  test('PMATRIX_DEBUG=1 → debug=true', () => {
    setEnv('PMATRIX_DEBUG', '1');
    const c = loadConfig('/non/existent.json');
    expect(c.debug).toBe(true);
  });

  test('PMATRIX_DEBUG 미설정 + file.debug=true → true', () => {
    unsetEnv('PMATRIX_DEBUG');
    const p = createTempConfig({ debug: true });
    const c = loadConfig(p);
    expect(c.debug).toBe(true);
  });
});

// =============================================================================
// 4. ${VAR} 환경변수 참조 치환
// =============================================================================

describe('loadConfig — apiKey ${VAR} 치환', () => {
  test('${MY_KEY} → process.env["MY_KEY"]', () => {
    setEnv('MY_KEY_TOKEN', 'secret-resolved');
    unsetEnv('PMATRIX_API_KEY');
    const p = createTempConfig({ apiKey: '${MY_KEY_TOKEN}' });

    const c = loadConfig(p);
    expect(c.apiKey).toBe('secret-resolved');
  });

  test('${UNDEFINED_VAR} → undefined → 기본값', () => {
    unsetEnv('PMATRIX_API_KEY');
    unsetEnv('UNDEFINED_VAR_XYZ');
    const p = createTempConfig({ apiKey: '${UNDEFINED_VAR_XYZ}' });

    const c = loadConfig(p);
    expect(c.apiKey).toBe(''); // DEFAULT_CONFIG.apiKey
  });

  test('리터럴 string (${...} 패턴 아님) → 그대로', () => {
    unsetEnv('PMATRIX_API_KEY');
    const p = createTempConfig({ apiKey: 'plain-literal-key' });

    const c = loadConfig(p);
    expect(c.apiKey).toBe('plain-literal-key');
  });
});
