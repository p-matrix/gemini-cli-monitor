// =============================================================================
// client.test.ts — PMatrixHttpClient 자가 검증 (v0.4.0 cross-cutting 포함)
// =============================================================================
//
// 검증 범위:
//   1. extractRtFromResponse — 정적 메서드: 완전/부분 응답 처리
//   2. healthCheck — fail-open: 성공/HTTP 503/네트워크/agentId 없음
//   3. sendBatch — 빈 배열 / 정상 / HTTP 500 → backupToLocal + error_id 로깅
//   4. Cross-cutting A — Error correlation logging (5xx body.error.error_id)
//   5. Cross-cutting B — X-Request-ID outgoing crypto.randomUUID() + echo trace
//   6. Cross-cutting C — Burst 429 handling (Retry-After + escalating backoff)
// =============================================================================

import * as fs from 'fs';
import { PMatrixHttpClient } from '../client';
import type { PMatrixConfig, BatchSendResponse, SignalPayload } from '../types';

// fs.promises 모킹 — backupToLocal 검증
jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  promises: {
    readdir: jest.fn().mockRejectedValue({ code: 'ENOENT' }),
    stat: jest.fn(),
    readFile: jest.fn(),
    unlink: jest.fn(),
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
  },
}));

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'test-agent',
    apiKey: 'test-key',
    safetyGate: { enabled: true, serverTimeoutMs: 2_500 },
    credentialProtection: { enabled: true, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75 },
    dataSharing: true,
    batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 },
    debug: false,
    ...overrides,
  };
}

function makeSignal(): SignalPayload {
  return {
    agent_id: 'test-agent',
    baseline: 1.0,
    norm: 1.0,
    stability: 0.0,
    meta_control: 1.0,
    timestamp: new Date().toISOString(),
    signal_source: 'gemini_cli_hook',
    framework: 'gemini_cli',
    framework_tag: 'beta',
    schema_version: '0.3',
    metadata: { event_type: 'unit_test' },
    state_vector: null,
  };
}

/** mock fetch — 200 OK with body */
function mockFetchOk(body: unknown, headers: Record<string, string> = {}) {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null },
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response);
}

/** mock fetch — error with body + headers */
function mockFetchFail(
  status = 500,
  text = 'Internal Server Error',
  headers: Record<string, string> = {}
) {
  return jest.fn().mockResolvedValue({
    ok: false,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null },
    text: jest.fn().mockResolvedValue(text),
  } as unknown as Response);
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env['PMATRIX_DEBUG_TRACE'];
});

// =============================================================================
// 1. extractRtFromResponse
// =============================================================================

describe('extractRtFromResponse — 완전/부분 응답', () => {
  test('완전 응답 → rt/grade/mode/axes', () => {
    const res: BatchSendResponse = {
      received: 1,
      risk: 0.25,
      grade: 'B',
      mode: 'caution',
      axes: { baseline: 0.9, norm: 0.8, stability: 0.1, meta_control: 0.95 },
    };
    const r = PMatrixHttpClient.extractRtFromResponse(res);
    expect(r).not.toBeNull();
    expect(r!.rt).toBe(0.25);
    expect(r!.mode).toBe('caution');
    expect(r!.grade).toBe('B');
    expect(r!.axes.baseline).toBe(0.9);
  });

  test('risk 없음 → null', () => {
    expect(
      PMatrixHttpClient.extractRtFromResponse({
        received: 1,
        grade: 'B',
        mode: 'caution',
        axes: { baseline: 0, norm: 0, stability: 0, meta_control: 0 },
      })
    ).toBeNull();
  });

  test('axes 없음 → null', () => {
    expect(
      PMatrixHttpClient.extractRtFromResponse({
        received: 1,
        risk: 0.5,
        grade: 'C',
        mode: 'alert',
      })
    ).toBeNull();
  });

  test('received만 → null', () => {
    expect(PMatrixHttpClient.extractRtFromResponse({ received: 0 })).toBeNull();
  });
});

// =============================================================================
// 2. healthCheck — fail-open
// =============================================================================

describe('healthCheck — fail-open', () => {
  const gradeData = {
    agent_id: 'test-agent',
    grade: 'B',
    p_score: 80,
    risk: 0.2,
    mode: 'caution',
    axes: { baseline: 0.9, norm: 0.8, stability: 0.1, meta_control: 0.95 },
    last_updated: new Date().toISOString(),
  };

  test('fetch 성공 → healthy=true', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(mockFetchOk(gradeData));
    const c = new PMatrixHttpClient(makeConfig());
    const r = await c.healthCheck();
    expect(r.healthy).toBe(true);
    expect(r.grade!.grade).toBe('B');
  });

  test('HTTP 503 → healthy=false', async () => {
    // suppress error correlation stderr noise
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(global, 'fetch').mockImplementation(mockFetchFail(503, 'unavail'));
    const c = new PMatrixHttpClient(makeConfig());
    const r = await c.healthCheck();
    expect(r.healthy).toBe(false);
    expect(r.grade).toBeUndefined();
  });

  test('네트워크 에러 → healthy=false', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const c = new PMatrixHttpClient(makeConfig());
    expect((await c.healthCheck()).healthy).toBe(false);
  });

  test('agentId 빈 문자열 → fetch 미호출', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const c = new PMatrixHttpClient(makeConfig({ agentId: '' }));
    expect((await c.healthCheck()).healthy).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 3. sendBatch
// =============================================================================

describe('sendBatch', () => {
  test('빈 배열 → fetch 미호출', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const c = new PMatrixHttpClient(makeConfig());
    expect(await c.sendBatch([])).toEqual({ received: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('정상 전송', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(mockFetchOk({ received: 1 }));
    const c = new PMatrixHttpClient(makeConfig());
    const r = await c.sendBatch([makeSignal()]);
    expect(r.received).toBe(1);
  });

  test('HTTP 500 → backupToLocal 호출 + error 재throw', async () => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(global, 'fetch').mockImplementation(mockFetchFail(500));
    const c = new PMatrixHttpClient(makeConfig());

    await expect(c.sendBatch([makeSignal()])).rejects.toThrow('HTTP 500');
    expect((fs.promises as jest.Mocked<typeof fs.promises>).mkdir).toHaveBeenCalled();
    expect((fs.promises as jest.Mocked<typeof fs.promises>).writeFile).toHaveBeenCalled();
  });

  test('all-zero axes → 0.5로 보정 후 전송', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(mockFetchOk({ received: 1 }));
    const c = new PMatrixHttpClient(makeConfig());
    const sig: SignalPayload = {
      ...makeSignal(),
      baseline: 0, norm: 0, stability: 0, meta_control: 0,
    };
    await c.sendBatch([sig]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callBody = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(callBody.baseline).toBe(0.5);
    expect(callBody.norm).toBe(0.5);
    expect(callBody.stability).toBe(0.5);
    expect(callBody.meta_control).toBe(0.5);
  });
});

// =============================================================================
// 4. Cross-cutting A — Error correlation logging (5xx)
// =============================================================================

describe('Cross-cutting A — Error correlation logging', () => {
  test('5xx body.error.error_id → stderr 안내 메시지', async () => {
    const stderrCaptured: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation(((msg: string) => {
      stderrCaptured.push(msg);
      return true;
    }) as any);

    const errBody = JSON.stringify({
      error: { error_id: 'err_abc123', request_id: 'req_xyz789' },
    });
    jest.spyOn(global, 'fetch').mockImplementation(mockFetchFail(503, errBody));

    const c = new PMatrixHttpClient(makeConfig());
    await expect(c.sendBatch([makeSignal()])).rejects.toThrow('HTTP 503');

    const correlationLog = stderrCaptured.find((m) => m.includes('error_id=err_abc123'));
    expect(correlationLog).toBeDefined();
    expect(correlationLog).toContain('request_id=req_xyz789');
    expect(correlationLog).toContain('Support 문의');
  });

  test('body 파싱 실패 → X-Error-ID / X-Request-ID 헤더 fallback', async () => {
    const stderrCaptured: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation(((msg: string) => {
      stderrCaptured.push(msg);
      return true;
    }) as any);

    jest.spyOn(global, 'fetch').mockImplementation(
      mockFetchFail(500, 'plain text body', {
        'x-error-id': 'err_fromheader',
        'x-request-id': 'req_fromheader',
      })
    );

    const c = new PMatrixHttpClient(makeConfig());
    await expect(c.sendBatch([makeSignal()])).rejects.toThrow();

    const log = stderrCaptured.find((m) => m.includes('error_id=err_fromheader'));
    expect(log).toBeDefined();
    expect(log).toContain('request_id=req_fromheader');
  });

  test('error_id 없음 → "(none)" 표기', async () => {
    const stderrCaptured: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation(((msg: string) => {
      stderrCaptured.push(msg);
      return true;
    }) as any);

    jest.spyOn(global, 'fetch').mockImplementation(mockFetchFail(502, 'gateway timeout'));

    const c = new PMatrixHttpClient(makeConfig());
    await expect(c.sendBatch([makeSignal()])).rejects.toThrow();

    // R-X.3 migration: core-sdk standardizes on '<none>' token across all 6 SDK
    expect(stderrCaptured.some((m) => m.includes('error_id=<none>'))).toBe(true);
  });

  test('4xx 응답 (5xx 아님) → correlation log 없음', async () => {
    const stderrCaptured: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation(((msg: string) => {
      stderrCaptured.push(msg);
      return true;
    }) as any);

    jest.spyOn(global, 'fetch').mockImplementation(mockFetchFail(404, 'not found'));

    const c = new PMatrixHttpClient(makeConfig());
    await expect(c.sendBatch([makeSignal()])).rejects.toThrow('HTTP 404');

    expect(stderrCaptured.some((m) => m.includes('error_id='))).toBe(false);
  });
});

// =============================================================================
// 5. Cross-cutting B — X-Request-ID
// =============================================================================

describe('Cross-cutting B — X-Request-ID', () => {
  test('outgoing 요청에 X-Request-ID 포함 (UUID 형식)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(mockFetchOk({ received: 1 }));
    const c = new PMatrixHttpClient(makeConfig());
    await c.sendBatch([makeSignal()]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const reqInit = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = reqInit.headers as Record<string, string>;
    expect(headers['X-Request-ID']).toBeDefined();
    // UUID v4 format: 8-4-4-4-12
    expect(headers['X-Request-ID']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('각 요청마다 새 UUID', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(mockFetchOk({ received: 1 }));
    const c = new PMatrixHttpClient(makeConfig());
    await c.sendBatch([makeSignal()]);
    await c.sendBatch([makeSignal()]);

    const id1 = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    const id2 = (fetchSpy.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(id1['X-Request-ID']).not.toBe(id2['X-Request-ID']);
  });

  test('PMATRIX_DEBUG_TRACE=1 → response echo trace stderr', async () => {
    process.env['PMATRIX_DEBUG_TRACE'] = '1';
    const stderrCaptured: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation(((msg: string) => {
      stderrCaptured.push(msg);
      return true;
    }) as any);

    jest.spyOn(global, 'fetch').mockImplementation(
      mockFetchOk({ received: 1 }, { 'x-request-id': 'req_echoed_value' })
    );

    const c = new PMatrixHttpClient(makeConfig());
    await c.sendBatch([makeSignal()]);

    // R-X.3 migration: core-sdk standardizes on cursor's trace format
    // ([P-MATRIX] trace: client_request_id=X server_request_id=Y status=Z)
    const trace = stderrCaptured.find((m) => m.includes('trace:') && m.includes('server_request_id='));
    expect(trace).toBeDefined();
    expect(trace).toContain('server_request_id=req_echoed_value');
  });

  test('PMATRIX_DEBUG_TRACE 미설정 → echo trace 없음', async () => {
    const stderrCaptured: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation(((msg: string) => {
      stderrCaptured.push(msg);
      return true;
    }) as any);

    jest.spyOn(global, 'fetch').mockImplementation(mockFetchOk({ received: 1 }));
    const c = new PMatrixHttpClient(makeConfig());
    await c.sendBatch([makeSignal()]);

    expect(stderrCaptured.some((m) => m.includes('X-Request-ID send='))).toBe(false);
  });
});

// =============================================================================
// 6. Cross-cutting C — Burst 429 handling
// =============================================================================

describe('Cross-cutting C — Burst 429 handling', () => {
  test('429 Retry-After (delta-seconds) → 그 값 사용 후 재시도', async () => {
    jest.useFakeTimers();
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockImplementationOnce(mockFetchFail(429, 'rate limited', { 'retry-after': '2' }))
      .mockImplementationOnce(mockFetchOk({ received: 1 }));

    const c = new PMatrixHttpClient(makeConfig({
      batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 1 },
    }));
    const promise = c.sendBatch([makeSignal()]);

    // Retry-After 2초 → 정확히 2000ms timer 진행
    await jest.advanceTimersByTimeAsync(2_000);
    const r = await promise;

    expect(r.received).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  test('429 Retry-After 없음 → BURST_RETRY_DELAYS escalating (1초)', async () => {
    jest.useFakeTimers();
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockImplementationOnce(mockFetchFail(429, 'rate'))
      .mockImplementationOnce(mockFetchOk({ received: 1 }));

    const c = new PMatrixHttpClient(makeConfig({
      batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 1 },
    }));
    const promise = c.sendBatch([makeSignal()]);

    // 첫 attempt 실패 후 BURST_RETRY_DELAYS[0] = 1000ms
    await jest.advanceTimersByTimeAsync(1_000);
    const r = await promise;
    expect(r.received).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  test('429 retryMax=0 → 단일 시도 후 429 throw', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(mockFetchFail(429, 'rate'));
    const c = new PMatrixHttpClient(makeConfig({
      batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 },
    }));

    await expect(c.sendBatch([makeSignal()])).rejects.toThrow('HTTP 429');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('429 retryMax=0 + 최종 fail 시 backupToLocal 호출', async () => {
    // retryMax=0 → 단일 시도 후 즉시 throw, fake timers 불필요
    jest.spyOn(global, 'fetch').mockImplementation(mockFetchFail(429));
    const c = new PMatrixHttpClient(makeConfig({
      batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 },
    }));

    await expect(c.sendBatch([makeSignal()])).rejects.toThrow('HTTP 429');

    expect((fs.promises as jest.Mocked<typeof fs.promises>).mkdir).toHaveBeenCalled();
    expect((fs.promises as jest.Mocked<typeof fs.promises>).writeFile).toHaveBeenCalled();
  });
});
