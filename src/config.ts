// =============================================================================
// @pmatrix/gemini-cli-monitor — config.ts
// ~/.pmatrix/config.json + 환경변수 → PMatrixConfig 로더
// 100% reuse from @pmatrix/cursor-monitor — framework-agnostic config format
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  PMatrixConfig,
  SafetyGateConfig,
  CredentialProtectionConfig,
  KillSwitchConfig,
  BatchConfig,
} from './types';

// ─── 기본값 ───────────────────────────────────────────────────────────────────

const DEFAULT_SAFETY_GATE: SafetyGateConfig = {
  enabled: true,
  serverTimeoutMs: 2_500,  // fail-open: 2.5초 초과 → PERMIT
  customToolRisk: {},
};

const DEFAULT_CREDENTIAL_PROTECTION: CredentialProtectionConfig = {
  enabled: true,
  customPatterns: [],
};

const DEFAULT_KILL_SWITCH: KillSwitchConfig = {
  autoHaltOnRt: 0.75,
};

const DEFAULT_BATCH: BatchConfig = {
  maxSize: 10,
  flushIntervalMs: 2_000,
  retryMax: 3,
};

const DEFAULT_CONFIG: PMatrixConfig = {
  serverUrl: 'https://api.pmatrix.io',
  agentId: '',
  apiKey: '',
  safetyGate: DEFAULT_SAFETY_GATE,
  credentialProtection: DEFAULT_CREDENTIAL_PROTECTION,
  killSwitch: DEFAULT_KILL_SWITCH,
  dataSharing: false,
  batch: DEFAULT_BATCH,
  frameworkTag: 'stable',
  debug: false,
};

// ─── File config interface ────────────────────────────────────────────────────

interface PMatrixFileConfig {
  serverUrl?: string;
  agentId?: string;
  apiKey?: string;
  safetyGate?: Partial<SafetyGateConfig>;
  credentialProtection?: Partial<CredentialProtectionConfig>;
  killSwitch?: Partial<KillSwitchConfig>;
  dataSharing?: boolean;
  agreedAt?: string;
  batch?: Partial<BatchConfig>;
  frameworkTag?: 'beta' | 'stable';
  debug?: boolean;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * P-MATRIX 설정 로드
 *
 * 우선순위: 환경변수 > ~/.pmatrix/config.json > 기본값
 *
 * 환경변수:
 *   PMATRIX_API_KEY      — API 키
 *   PMATRIX_SERVER_URL   — 서버 URL 오버라이드
 *   PMATRIX_AGENT_ID     — 에이전트 ID 오버라이드
 *   PMATRIX_DEBUG=1      — 디버그 로그 활성화
 */
export function loadConfig(configPath?: string): PMatrixConfig {
  const pm = configPath
    ? readJsonFile(configPath)
    : readPMatrixConfig();

  return {
    serverUrl:
      process.env['PMATRIX_SERVER_URL'] ??
      pm.serverUrl ??
      DEFAULT_CONFIG.serverUrl,

    agentId:
      process.env['PMATRIX_AGENT_ID'] ??
      pm.agentId ??
      DEFAULT_CONFIG.agentId,

    apiKey:
      process.env['PMATRIX_API_KEY'] ??
      resolveEnvRef(pm.apiKey) ??
      DEFAULT_CONFIG.apiKey,

    debug:
      process.env['PMATRIX_DEBUG'] === '1' ||
      (pm.debug ?? DEFAULT_CONFIG.debug),

    dataSharing: pm.dataSharing ?? DEFAULT_CONFIG.dataSharing,
    agreedAt: pm.agreedAt,
    frameworkTag: pm.frameworkTag ?? DEFAULT_CONFIG.frameworkTag,

    safetyGate: {
      ...DEFAULT_SAFETY_GATE,
      ...pm.safetyGate,
    },

    credentialProtection: {
      ...DEFAULT_CREDENTIAL_PROTECTION,
      ...pm.credentialProtection,
    },

    killSwitch: {
      ...DEFAULT_KILL_SWITCH,
      ...pm.killSwitch,
    },

    batch: {
      ...DEFAULT_BATCH,
      ...pm.batch,
    },
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function readPMatrixConfig(): PMatrixFileConfig {
  const configPath = path.join(os.homedir(), '.pmatrix', 'config.json');
  return readJsonFile(configPath);
}

function readJsonFile(filePath: string): PMatrixFileConfig {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as PMatrixFileConfig;
  } catch {
    return {};
  }
}

function resolveEnvRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(.+)\}$/);
  if (match && match[1]) {
    return process.env[match[1]];
  }
  return value;
}
