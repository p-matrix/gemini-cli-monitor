// =============================================================================
// @pmatrix/gemini-cli-monitor — client.ts
// =============================================================================
// R-X.3 migration: PMatrixHttpClient extracted to @pmatrix/core-sdk v0.1.0.
// Thin Gemini-CLI-bound wrapper pre-supplying AdapterIdentity.
// =============================================================================

import { PMatrixHttpClient as CorePMatrixHttpClient } from '@pmatrix/core-sdk';
import type {
  AdapterIdentity,
  PMatrixConfig,
} from '@pmatrix/core-sdk';

export type { SessionSummaryInput } from '@pmatrix/core-sdk';

const GEMINI_CLI_IDENTITY: AdapterIdentity = Object.freeze({
  signalSource: 'gemini_cli_hook',
  framework: 'gemini_cli',
});

export class PMatrixHttpClient extends CorePMatrixHttpClient {
  constructor(config: PMatrixConfig) {
    super(config, GEMINI_CLI_IDENTITY);
  }
}
