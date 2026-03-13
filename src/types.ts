// =============================================================================
// @pmatrix/gemini-cli-monitor — types.ts
// P-MATRIX 공유 타입 (4축, 신호 페이로드, API 응답, 설정)
//
// 기반: @pmatrix/cursor-monitor types.ts
// 변경: signal_source → 'gemini_cli_hook', framework → 'gemini_cli'
// =============================================================================

// ─── 5-Mode and Grade ─────────────────────────────────────────────────────────

/** P-MATRIX 5-Mode (Server constants.py 경계값 기준) */
export type SafetyMode = 'A+1' | 'A+0' | 'A-1' | 'A-2' | 'A-0';

/** Trust Grade */
export type TrustGrade = 'A' | 'B' | 'C' | 'D' | 'E';

/** Tool risk tier */
export type ToolRiskTier = 'HIGH' | 'MEDIUM' | 'LOW';

/** Safety Gate action */
export type GateAction = 'ALLOW' | 'BLOCK';

// ─── 4-axis state ─────────────────────────────────────────────────────────────
//
// Stability axis polarity convention:
//   Monitor sends "instability" — higher value = more unstable (0=safe, 1.0=HALT).
//   Server inverts stability for R(t) computation.
//   Same field name, opposite semantic at producer vs consumer.
//

export interface AxesState {
  baseline: number;
  norm: number;
  /** Instability score: 0=stable, 1.0=maximum instability. Server inverts via (1-stability). */
  stability: number;
  meta_control: number;
}

// ─── Signal Payload (POST /v1/inspect/stream) ─────────────────────────────────

/**
 * POST /v1/inspect/stream payload — gemini_cli_hook variant
 * signal_source: 'gemini_cli_hook', framework: 'gemini_cli'
 */
export interface SignalPayload {
  agent_id: string;
  baseline: number;
  norm: number;
  stability: number;
  meta_control: number;
  timestamp: string;
  signal_source: 'gemini_cli_hook';
  framework: 'gemini_cli';
  framework_tag: 'beta' | 'stable';
  schema_version: '0.3';
  metadata: SignalMetadata;
  state_vector: null;
}

export interface SignalMetadata {
  session_id?: string;
  event_type?: string;
  tool_name?: string;
  priority?: 'critical' | 'normal';
  meta_control_delta?: number;
  baseline_delta?: number;
  danger_events?: number;
  credential_blocks?: number;
  safety_gate_blocks?: number;
  total_turns?: number;
  end_reason?: string;
  is_halted?: boolean;
  [key: string]: unknown;
}

// ─── API Response types ───────────────────────────────────────────────────────

export interface BatchSendResponse {
  received: number;
  risk?: number;
  grade?: TrustGrade;
  mode?: SafetyMode;
  axes?: {
    baseline: number;
    norm: number;
    stability: number;
    meta_control: number;
  };
}

export interface GradeResponse {
  agent_id: string;
  grade: TrustGrade;
  p_score: number;
  risk: number;
  mode: SafetyMode;
  axes: {
    baseline: number;
    norm: number;
    stability: number;
    meta_control: number;
  };
  last_updated: string;
}

export interface AgentGradeHistoryItem {
  grade: TrustGrade;
  p_score: number;
  completed_at: string;
}

export interface AgentGradeDetail {
  current_grade: TrustGrade | null;
  p_score: number | null;
  issued_at: string | null;
  expires_at: string | null;
  prev_grade: TrustGrade | null;
  prev_p_score: number | null;
  history: AgentGradeHistoryItem[];
}

// ─── Config types ─────────────────────────────────────────────────────────────

export interface SafetyGateConfig {
  enabled: boolean;
  serverTimeoutMs: number;
  customToolRisk?: Record<string, ToolRiskTier>;
}

export interface CredentialProtectionConfig {
  enabled: boolean;
  customPatterns: string[];
}

export interface KillSwitchConfig {
  autoHaltOnRt: number;
}

export interface BatchConfig {
  maxSize: number;
  flushIntervalMs: number;
  retryMax: number;
}

export interface PMatrixConfig {
  serverUrl: string;
  agentId: string;
  apiKey: string;
  safetyGate: SafetyGateConfig;
  credentialProtection: CredentialProtectionConfig;
  killSwitch: KillSwitchConfig;
  dataSharing: boolean;
  agreedAt?: string;
  batch: BatchConfig;
  frameworkTag?: 'beta' | 'stable';
  debug: boolean;
}
