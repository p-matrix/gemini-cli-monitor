// =============================================================================
// credential-scanner.ts — Re-export from @pmatrix/core-sdk (A19-2 extract)
// =============================================================================
// Previously duplicated across 5 SDK (100 LOC × 5 = 500 LOC). Now unified in
// @pmatrix/core-sdk/credential-scanner. ScanResult interface re-exported for
// downstream type usage (cursor uses it externally).
// =============================================================================

export { scanCredentials } from '@pmatrix/core-sdk';
export type { ScanResult } from '@pmatrix/core-sdk';
