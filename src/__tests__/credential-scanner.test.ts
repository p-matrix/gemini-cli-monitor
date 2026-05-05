// =============================================================================
// credential-scanner.test.ts — scanCredentials 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. 빈 입력 / null-safe
//   2. 16 내장 패턴 — 핵심 패턴 검출 + count 누적
//   3. TEST_EXCLUSIONS — sk-test-/example/placeholder 등 필터
//   4. 코드블록 제거 — ``` / ~~~ / inline `
//   5. customPatterns — 추가 정규식 + invalid pattern silent skip
// =============================================================================

import { scanCredentials } from '../credential-scanner';

describe('scanCredentials — 기본 동작', () => {
  test('빈 문자열 → []', () => {
    expect(scanCredentials('')).toEqual([]);
  });

  test('일반 텍스트 → []', () => {
    expect(scanCredentials('Hello world, no secrets here.')).toEqual([]);
  });

  test('customPatterns 기본값 → 정상 동작', () => {
    expect(() => scanCredentials('text')).not.toThrow();
  });
});

describe('scanCredentials — 내장 패턴 16종', () => {
  test('OpenAI Project Key (sk-proj-)', () => {
    const r = scanCredentials('key = sk-proj-abcdefghijklmnopqrstu');
    expect(r).toEqual([{ name: 'OpenAI Project Key', count: 1 }]);
  });

  test('Anthropic Key (sk-ant-)', () => {
    const r = scanCredentials('sk-ant-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN');
    expect(r).toEqual([{ name: 'Anthropic Key', count: 1 }]);
  });

  test('AWS Access Key (AKIA...)', () => {
    const r = scanCredentials('AWS_ACCESS_KEY_ID=AKIAIAAAABBBBBBBBBBBB');
    expect(r.find((x) => x.name === 'AWS Access Key')?.count).toBe(1);
  });

  test('GitHub Token (ghp_)', () => {
    const r = scanCredentials('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(r.find((x) => x.name === 'GitHub Token')?.count).toBe(1);
  });

  test('Private Key (PEM)', () => {
    const r = scanCredentials('-----BEGIN RSA PRIVATE KEY-----\nMIIE...');
    expect(r.find((x) => x.name === 'Private Key (PEM)')?.count).toBe(1);
  });

  test('Database URL (postgres)', () => {
    const r = scanCredentials('DATABASE_URL=postgresql://user:secret123@host:5432/db');
    expect(r.find((x) => x.name === 'Database URL')?.count).toBe(1);
  });

  test('Bearer Token', () => {
    const r = scanCredentials('Authorization: Bearer abc.def-ghijklmnopqrstuvwxyz');
    expect(r.find((x) => x.name === 'Bearer Token')?.count).toBe(1);
  });

  test('Google AI Key (AIza...)', () => {
    const r = scanCredentials('GOOGLE_API_KEY=AIzaSyAbcdefghijklmnopqrstuvwxyz0123456');
    expect(r.find((x) => x.name === 'Google AI Key')?.count).toBe(1);
  });

  test('npm Token', () => {
    const r = scanCredentials('npm_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(r.find((x) => x.name === 'npm Token')?.count).toBe(1);
  });

  test('복수 매칭 → count 누적', () => {
    const text = 'k1=ghp_abcdefghijklmnopqrstuvwxyz0123456789 k2=ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
    const r = scanCredentials(text);
    expect(r.find((x) => x.name === 'GitHub Token')?.count).toBe(2);
  });
});

describe('scanCredentials — TEST_EXCLUSIONS 필터', () => {
  test('sk-test-... → 필터링', () => {
    expect(scanCredentials('key = sk-test-abc123')).toEqual([]);
  });

  test('placeholder 포함 → 필터링', () => {
    expect(scanCredentials('key = sk-placeholder-abcdef')).toEqual([]);
  });

  test('실제 형식 + your-api-key-here 컨텍스트 → 탐지됨 (전역 스킵 없음)', () => {
    const r = scanCredentials('your-api-key-here: sk-proj-abcdefghijklmnopqrstu');
    expect(r).toEqual([{ name: 'OpenAI Project Key', count: 1 }]);
  });
});

describe('scanCredentials — 코드블록 제거', () => {
  test('펜스드 코드블록 (```...```) 내부 시크릿 무시', () => {
    const text = 'before\n```\nsk-proj-abcdefghijklmnopqrstu\n```\nafter';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('~~~ 코드블록 내부 무시', () => {
    const text = '~~~\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n~~~';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('inline 코드 (`...`) 내부 무시', () => {
    const text = 'token: `ghp_abcdefghijklmnopqrstuvwxyz0123456789`';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('코드블록 밖은 정상 탐지', () => {
    const text = '```\nplaceholder text\n```\nactual: ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    expect(scanCredentials(text).find((x) => x.name === 'GitHub Token')?.count).toBe(1);
  });
});

describe('scanCredentials — customPatterns', () => {
  test('유효 정규식 추가', () => {
    const r = scanCredentials('CUSTOM-TOKEN-XYZ-12345', ['CUSTOM-TOKEN-[A-Z0-9-]+']);
    expect(r.find((x) => x.name === 'Custom Pattern')?.count).toBe(1);
  });

  test('invalid 정규식 → silent skip (다른 패턴은 정상)', () => {
    const captured: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((msg: string) => {
      captured.push(msg);
      return true;
    }) as any;

    try {
      const r = scanCredentials('ghp_abcdefghijklmnopqrstuvwxyz0123456789', ['[invalid(']);
      expect(r.find((x) => x.name === 'GitHub Token')?.count).toBe(1);
      // invalid pattern warning emitted
      expect(captured.some((m) => m.includes('invalid'))).toBe(true);
    } finally {
      process.stderr.write = origStderr;
    }
  });
});
