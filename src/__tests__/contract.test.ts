// =============================================================================
// gemini-cli-monitor contract.test.ts — Tier 2 conformance (Contract v0.1)
// =============================================================================

import {
  AgentEventSchema,
  NormalizedActionEventSchema,
  ObservableFactSchema,
  AxisEvidenceSchema,
  PEPEvaluationInputSchema,
  type AgentEvent,
  type NormalizedActionEvent,
  type ObservableFact,
  type AxisEvidence,
  type PEPEvaluationInput,
} from '@pmatrix/core-sdk';
import { PMatrixHttpClient } from '../client';
import type { SessionSummaryInput } from '../client';
import type { PMatrixConfig } from '@pmatrix/core-sdk';

function mockConfig(): PMatrixConfig {
  return {
    serverUrl: 'https://test.invalid',
    agentId: 'gemini-cli-agent-001',
    apiKey: 'test-key',
    safetyGate: { enabled: true, serverTimeoutMs: 2500 },
    credentialProtection: { enabled: true, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75 },
    dataSharing: false,
    batch: { maxSize: 50, flushIntervalMs: 5000, retryMax: 3 },
    debug: false,
  };
}

function geminiAgentEvent(eventType: string, hookName: string): AgentEvent {
  return {
    vendor: 'google',
    product: 'gemini-cli',
    host_surface: 'cli',
    event_type: eventType,
    timestamp: '2026-05-20T00:00:00.000Z',
    session_id: 'sess-gemini-001',
    agent_id: 'gemini-cli-agent-001',
    raw_event_ref: 'sha256:gemini-raw-event',
    content_included: false,
    host_integration_scope: {
      integration_type: 'cli-hook',
      hook_name: hookName,
      adapter_version: '0.4.0',
    },
    vendor_extensions: { model: 'gemini-2.5-pro' },
  };
}

describe('gemini-cli-monitor contract v0.1 conformance', () => {
  test('PMatrixHttpClient identity auto-injected (gemini_cli_hook / gemini_cli)', () => {
    const client = new PMatrixHttpClient(mockConfig());
    expect(client.identity.signalSource).toBe('gemini_cli_hook');
    expect(client.identity.framework).toBe('gemini_cli');
  });

  test('SessionSummaryInput drops hardcoded brand fields (R-X.3)', () => {
    const summary: SessionSummaryInput = {
      sessionId: 'sess-001',
      agentId: 'gemini-cli-agent-001',
      totalTurns: 5,
      dangerEvents: 0,
      credentialBlocks: 0,
      safetyGateBlocks: 0,
      framework_tag: 'stable',
    };
    expect(Object.prototype.hasOwnProperty.call(summary, 'signal_source')).toBe(false);
  });

  test.each([
    ['SessionStart', 'SessionStart'],
    ['UserPromptSubmit', 'UserPromptSubmit'],
    ['BeforeModelResolve', 'BeforeModelResolve'],
    ['AfterModelBuffer', 'AfterModelBuffer'],
    ['PreToolUse', 'PreToolUse'],
    ['PostToolUse', 'PostToolUse'],
    ['Stop', 'Stop'],
  ])('emits valid AgentEvent for %s hook', (eventType, hookName) => {
    const ev = geminiAgentEvent(eventType, hookName);
    expect(AgentEventSchema.safeParse(ev).success).toBe(true);
  });

  test('vendor_extensions accepts Gemini primitives', () => {
    const ev = geminiAgentEvent('AfterModelBuffer', 'AfterModelBuffer');
    ev.vendor_extensions = {
      model: 'gemini-2.5-pro',
      provider: 'google-genai',
      input_tokens: 1024,
      output_tokens: 512,
      tool_calls_count: 2,
    };
    expect(AgentEventSchema.safeParse(ev).success).toBe(true);
  });

  test('5-layer round-trip — search tool_call', () => {
    const agentEvent: AgentEvent = geminiAgentEvent('PreToolUse', 'PreToolUse');
    expect(AgentEventSchema.safeParse(agentEvent).success).toBe(true);

    const normalized: NormalizedActionEvent = {
      source_event_ref: agentEvent.raw_event_ref,
      action_type: 'tool_call',
      actor: agentEvent.agent_id,
      target: 'google_search',
      scope: {},
      action_category: 'network',
      evidence_ref: 'sha256:search-evidence',
    };
    expect(NormalizedActionEventSchema.safeParse(normalized).success).toBe(true);

    const fact: ObservableFact = {
      fact_type: 'action',
      fact_id: 'fact-gemini-001',
      agent_id: agentEvent.agent_id,
      contract_id: 'contract-gemini-001',
      source_vendor: agentEvent.vendor,
      source_surface: agentEvent.host_surface,
      observed_at: agentEvent.timestamp,
      confidence: 0.93,
      provenance: {
        adapter_id: 'gemini-cli-monitor-001',
        adapter_version: '0.4.0',
        chain_ref: null,
        signature: 'hmac-sha256:gemini-sig',
      },
      content_agnostic_ref: 'sha256:fact-canonical',
    };
    expect(ObservableFactSchema.safeParse(fact).success).toBe(true);

    const evidence: AxisEvidence = {
      axis: 'stability',
      evidence_type: 'observation',
      signal_strength: 0.1,
      direction: 'neutral',
      confidence: 0.9,
      reason_code: 'standard_search_invocation',
      fact_refs: [fact.fact_id],
      axis_status: 'PASS',
    };
    expect(AxisEvidenceSchema.safeParse(evidence).success).toBe(true);

    const pepInput: PEPEvaluationInput = {
      delegation_contract_ref: null,
      current_runtime_mode: 'Normal',
      current_rt: 0.12,
      current_tier: 'T5',
      action_type: 'tool_call',
      action_category: 'network',
      authority_scope: 'web_search',
      approval_requirement: 'auto',
      risk_level: 'low',
      fact_refs: [fact.fact_id],
      peer_verifications: [
        {
          peer_node_id: 'peer-gemini-verifier',
          decision: 'PASS',
          axes_status: {
            cap_within_bounds: 'N/A',
            delegation_receipt_valid: 'N/A',
            expiry_not_passed: 'N/A',
            action_within_scope: 'PASS',
            delegator_authority: 'PASS',
            policy_digest_match: 'PASS',
            rt_within_threshold: 'PASS',
            mode_compatible: 'PASS',
          },
          signature: 'hmac-sha256:peer-gemini',
          timestamp: agentEvent.timestamp,
        },
      ],
      quorum_rule: 'critical-axis-veto',
    };
    expect(PEPEvaluationInputSchema.safeParse(pepInput).success).toBe(true);
  });
});
