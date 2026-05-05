// =============================================================================
// breach-support.test.ts — BreachSupport 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. constructor — authority_limit 캐시 로드 (없으면 null)
//   2. isInScope — allowed/denied action types + paths (graceful degradation)
//   3. Approval tracking — requested/granted/denied + getApprovalStatus
//   4. Blocked action history — getRecentBlocked window filter
//   5. Counters — toolCalls / fileMods / errors / denied
//   6. getSessionReport — actions_summary + duration_ms
//   7. inferDelegatedActionType — tool name → AP-1/2/3
//   8. enrichMetadata — in_scope + blocked_action_history
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 격리된 임시 HOME — os.homedir 자체를 mock
let tmpHome: string;
jest.mock('os', () => {
  const real = jest.requireActual<typeof import('os')>('os');
  return { ...real, homedir: jest.fn(() => tmpHome) };
});

import { BreachSupport } from '../breach-support';

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pmatrix-breach-'));
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function setAuthorityLimit(agentId: string, limit: object): void {
  const dir = path.join(tmpHome, '.pmatrix', 'cache', 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  const contractPath = path.join(dir, 'contract.json');
  fs.writeFileSync(contractPath, JSON.stringify({ data: { authority_limit: limit } }), 'utf-8');
}

// =============================================================================
// 1. constructor — authority_limit cache
// =============================================================================

describe('BreachSupport — constructor', () => {
  test('authority_limit 미존재 → null cache', () => {
    const b = new BreachSupport('agent-x');
    // graceful degradation: isInScope returns null when no authority_limit
    expect(b.isInScope('AP-1')).toBeNull();
  });

  test('contract.json 손상 → null cache (silent fail)', () => {
    const dir = path.join(tmpHome, '.pmatrix', 'cache', 'agents', 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'contract.json'), '{ invalid json', 'utf-8');

    const b = new BreachSupport('broken');
    expect(b.isInScope('AP-1')).toBeNull();
  });
});

// =============================================================================
// 2. isInScope
// =============================================================================

describe('isInScope — scope 검증', () => {
  test('allowed_action_types 매칭 → true', () => {
    setAuthorityLimit('a1', { allowed_action_types: ['AP-1', 'AP-2'] });
    const b = new BreachSupport('a1');
    expect(b.isInScope('AP-1')).toBe(true);
    expect(b.isInScope('AP-2')).toBe(true);
  });

  test('allowed_action_types 미매칭 → false', () => {
    setAuthorityLimit('a2', { allowed_action_types: ['AP-2'] });
    const b = new BreachSupport('a2');
    expect(b.isInScope('AP-1')).toBe(false);
  });

  test('allowed_paths prefix 매칭 → true', () => {
    setAuthorityLimit('a3', {
      allowed_action_types: ['AP-2'],
      allowed_paths: ['/workspace/**', '/tmp/build'],
    });
    const b = new BreachSupport('a3');
    expect(b.isInScope('AP-2', '/workspace/src/file.ts')).toBe(true);
    expect(b.isInScope('AP-2', '/tmp/build')).toBe(true);
  });

  test('allowed_paths 외 경로 → false', () => {
    setAuthorityLimit('a4', {
      allowed_action_types: ['AP-2'],
      allowed_paths: ['/workspace/**'],
    });
    const b = new BreachSupport('a4');
    expect(b.isInScope('AP-2', '/etc/passwd')).toBe(false);
  });

  test('denied_paths 매칭 → false', () => {
    setAuthorityLimit('a5', {
      allowed_action_types: ['AP-2'],
      allowed_paths: ['/workspace/**'],
      denied_paths: ['/workspace/secrets/**'],
    });
    const b = new BreachSupport('a5');
    expect(b.isInScope('AP-2', '/workspace/src/x')).toBe(true);
    expect(b.isInScope('AP-2', '/workspace/secrets/x')).toBe(false);
  });
});

// =============================================================================
// 3. Approval tracking
// =============================================================================

describe('Approval tracking', () => {
  test('requested → pending', () => {
    const b = new BreachSupport('a');
    b.recordApprovalRequested('act-1', 'write_file');
    expect(b.getApprovalStatus('act-1')).toBe('pending');
  });

  test('granted overrides requested', () => {
    const b = new BreachSupport('a');
    b.recordApprovalRequested('act-1', 'write_file');
    b.recordApprovalGranted('act-1');
    expect(b.getApprovalStatus('act-1')).toBe('granted');
  });

  test('denied overrides requested', () => {
    const b = new BreachSupport('a');
    b.recordApprovalRequested('act-1', 'write_file');
    b.recordApprovalDenied('act-1');
    expect(b.getApprovalStatus('act-1')).toBe('denied');
  });

  test('미존재 action_id → null', () => {
    const b = new BreachSupport('a');
    expect(b.getApprovalStatus('nope')).toBeNull();
  });
});

// =============================================================================
// 4. Blocked action history
// =============================================================================

describe('Blocked action history', () => {
  test('recordBlockedAction → getRecentBlocked 반환', () => {
    const b = new BreachSupport('a');
    b.recordBlockedAction('rm', 'destructive');
    const recent = b.getRecentBlocked(60_000);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.tool_name).toBe('rm');
    expect(recent[0]!.reason).toBe('destructive');
  });

  test('window 외 차단 → 제외', () => {
    const b = new BreachSupport('a');
    // 직접 시간 조작 — 현재 시간 - 120초
    (b as any).blockedActions.push({
      tool_name: 'old',
      timestamp: Date.now() - 120_000,
      reason: 'old reason',
    });
    b.recordBlockedAction('new', 'new reason');

    const recent = b.getRecentBlocked(60_000);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.tool_name).toBe('new');
  });
});

// =============================================================================
// 5. Counters
// =============================================================================

describe('Counters', () => {
  test('increment* + getter', () => {
    const b = new BreachSupport('a');
    b.incrementToolCalls();
    b.incrementToolCalls();
    b.incrementFileModifications();
    expect(b.getToolCallCount()).toBe(2);
    expect(b.getFileModCount()).toBe(1);
  });
});

// =============================================================================
// 6. getSessionReport
// =============================================================================

describe('getSessionReport', () => {
  test('actions_summary + duration_ms', async () => {
    const b = new BreachSupport('a');
    b.incrementToolCalls();
    b.incrementToolCalls();
    b.incrementFileModifications();
    b.incrementErrors();
    b.incrementDenied();

    await new Promise((r) => setTimeout(r, 5));
    const report = b.getSessionReport();
    expect(report.report_type).toBe('session_summary');
    expect(report.actions_summary.tool_calls_count).toBe(2);
    expect(report.actions_summary.file_modifications_count).toBe(1);
    expect(report.actions_summary.errors_count).toBe(1);
    expect(report.actions_summary.denied_count).toBe(1);
    expect(report.session_duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// 7. inferDelegatedActionType
// =============================================================================

describe('inferDelegatedActionType', () => {
  test('shell tools → AP-1', () => {
    const b = new BreachSupport('a');
    expect(b.inferDelegatedActionType('bash')).toBe('AP-1');
    expect(b.inferDelegatedActionType('run_shell_command')).toBe('AP-1');
    expect(b.inferDelegatedActionType('execute_command')).toBe('AP-1');
  });

  test('file tools → AP-2', () => {
    const b = new BreachSupport('a');
    expect(b.inferDelegatedActionType('write_file')).toBe('AP-2');
    expect(b.inferDelegatedActionType('create_file')).toBe('AP-2');
    expect(b.inferDelegatedActionType('edit_file')).toBe('AP-2');
    expect(b.inferDelegatedActionType('read_file')).toBe('AP-2');
  });

  test('web tools → AP-3', () => {
    const b = new BreachSupport('a');
    expect(b.inferDelegatedActionType('web_fetch')).toBe('AP-3');
    expect(b.inferDelegatedActionType('http_request')).toBe('AP-3');
    expect(b.inferDelegatedActionType('curl')).toBe('AP-3');
  });

  test('unknown tool → AP-1 (보수적 fallback)', () => {
    const b = new BreachSupport('a');
    expect(b.inferDelegatedActionType('unknown_tool')).toBe('AP-1');
  });

  test('undefined → undefined', () => {
    const b = new BreachSupport('a');
    expect(b.inferDelegatedActionType(undefined)).toBeUndefined();
  });
});

// =============================================================================
// 8. enrichMetadata
// =============================================================================

describe('enrichMetadata', () => {
  test('in_scope tagging — authority_limit 있을 때', () => {
    setAuthorityLimit('a', {
      allowed_action_types: ['AP-2'],
      allowed_paths: ['/workspace/**'],
    });
    const b = new BreachSupport('a');
    const r = b.enrichMetadata({}, {
      actionPrimitive: 'AP-2',
      filePath: '/workspace/x',
    });
    expect(r['in_scope']).toBe(true);
  });

  test('blocked_action_history 포함 (있을 때)', () => {
    const b = new BreachSupport('a');
    b.recordBlockedAction('rm', 'rm -rf')

    const r = b.enrichMetadata({});
    expect(r['blocked_action_history']).toEqual([
      expect.objectContaining({ tool: 'rm', reason: 'rm -rf' }),
    ]);
  });

  test('차단 없음 → blocked_action_history 미포함', () => {
    const b = new BreachSupport('a');
    const r = b.enrichMetadata({ existing: 1 });
    expect(r).toEqual({ existing: 1 });
  });
});
