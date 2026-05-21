// =============================================================================
// @pmatrix/gemini-cli-monitor — types.ts
// R-X.3 migration: shared types re-exported from @pmatrix/core-sdk.
// Gemini-CLI-narrowed SignalPayload preserves 'gemini_cli_hook' / 'gemini_cli'
// literals at the type-system level (structural subtype of core's generic).
//
// signal_source: 'gemini_cli_hook', framework: 'gemini_cli'
// host_surface: 'cli' (Google Gemini CLI)
// =============================================================================

// ─── Re-export shared types from @pmatrix/core-sdk ─────────────────────────

export type {
  SafetyMode,
  TrustGrade,
  ToolRiskTier,
  GateAction,
  AxesState,
  SignalMetadata,
  BatchSendResponse,
  GradeResponse,
  AgentGradeDetail,
  AgentGradeHistoryItem,
  HealthCheckResult,
  SafetyGateConfig,
  CredentialProtectionConfig,
  KillSwitchConfig,
  BatchConfig,
  PMatrixConfig,
} from '@pmatrix/core-sdk';

import type { SignalPayload as CoreSignalPayload } from '@pmatrix/core-sdk';

// ─── Gemini CLI-narrowed SignalPayload ─────────────────────────────────────
//
// Server-side framework enum: claude_code | openclaw | cursor | gemini_cli | codex | hermes

export interface SignalPayload extends Omit<CoreSignalPayload, 'signal_source' | 'framework'> {
  signal_source: 'gemini_cli_hook';
  framework: 'gemini_cli';
}
