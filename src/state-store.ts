// =============================================================================
// @pmatrix/gemini-cli-monitor — state-store.ts
// File-based session state persistence
//
// 기반: @pmatrix/cursor-monitor state-store.ts
// 변경: PersistedSessionState에 Gemini 전용 메타데이터 + 카운터 추가
//
// Each Gemini CLI hook invocation is a new process; in-memory state does not
// persist between calls. This module provides read/write to
// ~/.pmatrix/sessions/{session_id}.json for cross-invocation continuity.
//
// Design:
//   - Sync I/O only (hook invocations are short-lived, no event loop concern)
//   - Atomic write: write to temp file then rename
//   - Fail-open: any I/O error → return default state, never throw
//   - Cleanup: sessions older than SESSION_TTL_MS are removed on load
//
// KNOWN_LIMITATION: No file lock. Concurrent access mitigated by atomic write
// (temp→rename) + fail-open. Multi-monitor (3+) scenarios may increase collision
// probability. Monitor via corrupted-state log.
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SafetyMode, TrustGrade } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Session state TTL: 24 hours. Stale sessions auto-removed on cleanup. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

/** R(t) cache TTL: 30 seconds (same as OpenClaw) */
const RT_CACHE_TTL_MS = 30_000;

// ─── Persisted state schema ───────────────────────────────────────────────────

export interface PersistedSessionState {
  // ── 공통 (Claude Code / Cursor Monitor 동일) ─────────────────────────────
  sessionId: string;
  agentId: string;
  startedAt: string;        // ISO 8601

  // ── R(t) cache ─────────────────────────────────────────────────────────────
  currentRt: number;
  currentMode: SafetyMode;
  grade: TrustGrade | null;
  /** ISO 8601 — R(t) cache expiry (30s TTL) */
  rtCacheExpiry: string;

  // ── Kill Switch ─────────────────────────────────────────────────────────────
  isHalted: boolean;
  haltReason?: string;

  // ── 공통 세션 카운터 ─────────────────────────────────────────────────────────
  dangerEvents: number;
  credentialBlocks: number;
  safetyGateBlocks: number;
  totalTurns: number;
  permissionRequestCount: number;
  subagentSpawnCount: number;

  // ── Metadata ────────────────────────────────────────────────────────────────
  /** ISO 8601 — last update time (used for stale cleanup) */
  updatedAt: string;
  /** Monitor framework identifier — used to filter sessions in shared ~/.pmatrix/sessions/ */
  framework: string;

  // ── Gemini 전용 메타데이터 ──────────────────────────────────────────────────
  /** 세션 시작 원인 (startup / resume / clear) */
  sessionSource: string;
  /** 사용 모델명 */
  model: string;
  /** 워크스페이스 루트 (GEMINI_PROJECT_DIR) */
  workspaceRoot: string;

  // ── Gemini 전용 카운터 ─────────────────────────────────────────────────────
  /** BeforeModel 발화 횟수 */
  llmCallCount: number;
  /** AfterModel 집계 누적 토큰 */
  totalTokens: number;
  /** BeforeAgent 발화 횟수 (사용자 턴) */
  promptTurnCount: number;
  /** BeforeAgent credential 차단 횟수 */
  credentialBlockCount: number;
  /** PreCompress 발화 횟수 */
  compactCount: number;
  /** Notification ToolPermission 수신 횟수 (Policy Engine DENY 보상 경로) */
  policyDenyCount: number;
  /** AfterModel safetyRatings 플래그 횟수 */
  safetyFlagCount: number;
  /** BeforeTool deny 횟수 (Safety Gate 차단 포함) */
  toolDenyCount: number;
  /** AfterTool 발생 횟수 */
  toolCallCount: number;
}

// ─── Default state factory ────────────────────────────────────────────────────

export function createDefaultState(sessionId: string, agentId: string): PersistedSessionState {
  const now = new Date().toISOString();
  return {
    // 공통
    sessionId,
    agentId,
    startedAt: now,
    currentRt: 0,
    currentMode: 'A+1',
    grade: null,
    rtCacheExpiry: new Date(Date.now() - 1).toISOString(),  // expired immediately
    isHalted: false,
    dangerEvents: 0,
    credentialBlocks: 0,
    safetyGateBlocks: 0,
    totalTurns: 0,
    permissionRequestCount: 0,
    subagentSpawnCount: 0,
    updatedAt: now,
    framework: 'gemini_cli',
    // Gemini 전용 메타데이터
    sessionSource: '',
    model: '',
    workspaceRoot: '',
    // Gemini 전용 카운터
    llmCallCount: 0,
    totalTokens: 0,
    promptTurnCount: 0,
    credentialBlockCount: 0,
    compactCount: 0,
    policyDenyCount: 0,
    safetyFlagCount: 0,
    toolDenyCount: 0,
    toolCallCount: 0,
  };
}

// ─── R(t) cache helpers ───────────────────────────────────────────────────────

export function isRtCacheValid(state: PersistedSessionState): boolean {
  return Date.now() < new Date(state.rtCacheExpiry).getTime();
}

export function buildRtCacheExpiry(): string {
  return new Date(Date.now() + RT_CACHE_TTL_MS).toISOString();
}

// ─── Directory helper ─────────────────────────────────────────────────────────

function sessionsDir(): string {
  return path.join(os.homedir(), '.pmatrix', 'sessions');
}

function sessionFilePath(sessionId: string): string {
  // Sanitize session_id for safe filename
  const safe = sessionId.replace(/[^a-zA-Z0-9\-_]/g, '_').slice(0, 128);
  return path.join(sessionsDir(), `${safe}.json`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load session state from disk.
 * Returns null if the session file does not exist (new session).
 * Returns default state on parse error (fail-open).
 */
export function loadState(sessionId: string): PersistedSessionState | null {
  const filepath = sessionFilePath(sessionId);
  try {
    if (!fs.existsSync(filepath)) return null;
    const raw = fs.readFileSync(filepath, 'utf-8');
    const state = JSON.parse(raw) as PersistedSessionState;
    return state;
  } catch (err) {
    // Parse error or I/O error → treat as new session (fail-open)
    process.stderr.write(
      `[P-MATRIX] state-store: corrupted or unreadable state file for session=${sessionId} — ${(err as Error).message}\n`
    );
    return null;
  }
}

/**
 * Load or create session state.
 * Always returns a valid state object — fail-open for all errors.
 * Migration guard: backfills fields added after v0.1 (pre-existing state files may lack them).
 */
export function loadOrCreateState(sessionId: string, agentId: string): PersistedSessionState {
  const state = loadState(sessionId) ?? createDefaultState(sessionId, agentId);
  // Backfill guard — 공통 필드
  state.permissionRequestCount ??= 0;
  state.subagentSpawnCount ??= 0;
  // framework added for session collision prevention — pre-existing files lack this field
  state.framework ??= 'gemini_cli';
  // Backfill guard — Gemini 전용 메타데이터
  state.sessionSource ??= '';
  state.model ??= '';
  state.workspaceRoot ??= '';
  // Backfill guard — Gemini 전용 카운터
  state.llmCallCount ??= 0;
  state.totalTokens ??= 0;
  state.promptTurnCount ??= 0;
  state.credentialBlockCount ??= 0;
  state.compactCount ??= 0;
  state.policyDenyCount ??= 0;
  state.safetyFlagCount ??= 0;
  state.toolDenyCount ??= 0;
  state.toolCallCount ??= 0;
  return state;
}

/**
 * Save session state to disk.
 * Atomic: write to temp file first, then rename.
 * Windows: rename not atomic. On corruption, state is non-authoritative —
 * hook execution continues fail-open, score falls back to R(t)=0.0 (safe default).
 * Fail-open: any error is silently swallowed.
 */
export function saveState(state: PersistedSessionState): void {
  try {
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });

    const filepath = sessionFilePath(state.sessionId);
    const tmpPath = `${filepath}.tmp`;

    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filepath);
  } catch {
    // Fail-open: state save failure must not block hook response
  }
}

/**
 * Delete session state file (called on sessionEnd).
 * Fail-open: errors silently ignored.
 */
export function deleteState(sessionId: string): void {
  try {
    const filepath = sessionFilePath(sessionId);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  } catch {
    // ignore
  }
}

// ─── HALT file utilities ───────────────────────────────────────────────────────

/** Path to the global HALT file — presence means Kill Switch is active */
export function haltFilePath(): string {
  return path.join(os.homedir(), '.pmatrix', 'HALT');
}

export function isHaltActive(): boolean {
  try {
    return fs.existsSync(haltFilePath());
  } catch {
    return false;
  }
}

export function activateHalt(reason?: string): void {
  try {
    const dir = path.join(os.homedir(), '.pmatrix');
    fs.mkdirSync(dir, { recursive: true });
    const content = JSON.stringify({ activatedAt: new Date().toISOString(), reason: reason ?? '' });
    fs.writeFileSync(haltFilePath(), content, 'utf-8');
  } catch {
    // fail-open
  }
}

/**
 * Read the most recently updated active session from ~/.pmatrix/sessions/.
 * Used by MCP tools when no session_id is provided.
 * @param framework — filter by framework (e.g. 'gemini_cli'). If omitted, returns any framework.
 */
export function findActiveSession(framework?: string): PersistedSessionState | null {
  try {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return null;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return null;

    let latest: PersistedSessionState | null = null;
    let latestTime = 0;

    for (const filename of files) {
      try {
        const filepath = path.join(dir, filename);
        const raw = fs.readFileSync(filepath, 'utf-8');
        const state = JSON.parse(raw) as PersistedSessionState;
        // Filter by framework if specified — prevents cross-monitor session collision
        if (framework && state.framework && state.framework !== framework) continue;
        const t = new Date(state.updatedAt).getTime();
        if (t > latestTime) {
          latestTime = t;
          latest = state;
        }
      } catch {
        // skip unreadable files
      }
    }

    return latest;
  } catch {
    return null;
  }
}

/**
 * Remove stale session files older than SESSION_TTL_MS.
 * Called opportunistically on sessionStart — never blocks.
 */
export function cleanupStaleStates(): void {
  try {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return;

    const now = Date.now();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') || f.endsWith('.json.tmp'));

    for (const filename of files) {
      try {
        const filepath = path.join(dir, filename);
        const stat = fs.statSync(filepath);
        if (filename.endsWith('.tmp') || now - stat.mtimeMs > SESSION_TTL_MS) {
          fs.unlinkSync(filepath);
        }
      } catch {
        // ignore individual file errors
      }
    }
  } catch {
    // ignore all cleanup errors
  }
}
