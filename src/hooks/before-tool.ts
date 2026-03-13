// =============================================================================
// @pmatrix/gemini-cli-monitor — hooks/before-tool.ts
// BeforeTool hook handler — Safety Gate core (L-5 PASS 검증 완료)
//
// 기반: @pmatrix/claude-code-monitor hooks/pre-tool-use.ts (60% 재사용)
// 변경:
//   - 입력 타입: PreToolUseInput → GeminiBeforeToolInput
//   - 출력 타입: PreToolUseOutput → GeminiBeforeToolOutput (decision: 'deny'/'allow')
//   - 도구 분류: classifyToolRisk → classifyGeminiToolRisk (tool_input 포함)
//   - Meta-Control: run_shell_command → tool_input.command 원문 분석
//   - pmatrix_* MCP 자가 도구 early allow (신규)
//   - signal_source: 'gemini_cli_hook', framework: 'gemini_cli'
//
// Flow:
//   1. HALT file check (global Kill Switch)
//   2. safetyGate.enabled 체크 → disabled면 allow
//   3. Load session state
//   4. state.isHalted 체크
//   5. pmatrix_* early allow (재귀 방지)
//   6. run_shell_command → tool_input.command 추출 → Meta-Control 5규칙 검사
//   7. classifyGeminiToolRisk(tool_name, tool_input) → 위험 등급
//   8. fetchRtWithFailOpen → R(t)
//   9. evaluateSafetyGate(rt, risk) → ALLOW / BLOCK
//  10. GeminiBeforeToolOutput 반환
//
// stdout JSON 이스케이핑: index.ts에서 JSON.stringify 처리
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { PMatrixHttpClient } from '../client';
import { GeminiBeforeToolInput, GeminiBeforeToolOutput } from '../gemini-types';
import {
  classifyGeminiToolRisk,
  evaluateSafetyGate,
  checkMetaControlRules,
} from '../safety-gate';
import {
  loadOrCreateState,
  saveState,
  buildRtCacheExpiry,
  isRtCacheValid,
  isHaltActive,
  PersistedSessionState,
} from '../state-store';

export async function handleBeforeTool(
  event: GeminiBeforeToolInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<GeminiBeforeToolOutput> {
  const { session_id, tool_name, tool_input } = event;
  const agentId = config.agentId;

  // ① HALT file check — global Kill Switch, session state I/O 없이 즉시 차단
  if (isHaltActive()) {
    return buildDenyOutput(
      'P-MATRIX Kill Switch HALT active. All tool calls blocked. Remove ~/.pmatrix/HALT to resume.'
    );
  }

  // ② Safety Gate disabled → allow (credential 차단 등 별도 플래그와 무관)
  if (!config.safetyGate.enabled) {
    return buildAllowOutput();
  }

  // ③ Load state (fail-open)
  const state = loadOrCreateState(session_id, agentId);

  // ④ Session-level Kill Switch
  if (state.isHalted) {
    state.safetyGateBlocks += 1;
    state.toolDenyCount += 1;
    saveState(state);
    return buildDenyOutput(
      `P-MATRIX Kill Switch active: ${state.haltReason ?? 'R(t) ≥ 0.75'}`
    );
  }

  // ⑤ pmatrix_* MCP 자가 도구 early allow — 재귀 방지
  if (tool_name.startsWith('pmatrix_')) {
    saveState(state);
    return buildAllowOutput();
  }

  // ⑥ Meta-Control 5규칙 — run_shell_command 원문 분석
  //    tool_name이 run_shell_command이면 tool_input.command를 command 원문으로 사용
  //    그 외 도구: tool_name 자체 전달 (패턴 미매칭 → null)
  const shellCommand =
    tool_name === 'run_shell_command'
      ? ((tool_input?.['command'] as string | undefined) ?? tool_name)
      : tool_name;

  const mcBlock = checkMetaControlRules(shellCommand, null);
  if (mcBlock !== null) {
    const criticalSignal = buildSignal(state, session_id, tool_name, {
      event_type: 'meta_control_block',
      priority: 'critical',
      meta_control_delta: mcBlock.metaControlDelta,
    }, config.frameworkTag ?? 'stable', 0.05);
    client.sendCritical(criticalSignal).catch(() => {});

    state.dangerEvents += 1;
    state.safetyGateBlocks += 1;
    state.toolDenyCount += 1;
    saveState(state);

    return buildDenyOutput(`P-MATRIX Safety Gate: ${mcBlock.reason}`);
  }

  // ⑦ 도구 위험 분류 (tool_input 구조적 파라미터 포함 — write_file 경로 검사)
  const toolRisk = classifyGeminiToolRisk(
    tool_name,
    tool_input,
    config.safetyGate.customToolRisk
  );

  // ⑧ R(t) 조회 (fail-open: timeout/error → 캐시값 사용)
  const rt = await fetchRtWithFailOpen(state, session_id, tool_name, config, client);

  // ⑨ Safety Gate 판정
  const gateResult = evaluateSafetyGate(rt, toolRisk);

  if (gateResult.action === 'BLOCK') {
    const blockSignal = buildSignal(state, session_id, tool_name, {
      event_type: 'safety_gate_block',
      priority: 'critical',
    }, config.frameworkTag ?? 'stable', 0.05);
    client.sendCritical(blockSignal).catch(() => {});

    state.safetyGateBlocks += 1;
    state.toolDenyCount += 1;
    state.dangerEvents += 1;

    if (rt >= config.killSwitch.autoHaltOnRt) {
      state.isHalted = true;
      state.haltReason = `R(t) ${rt.toFixed(2)} ≥ ${config.killSwitch.autoHaltOnRt}`;
    }
    saveState(state);

    return buildDenyOutput(`P-MATRIX Safety Gate: ${gateResult.reason}`);
  }

  // ALLOW
  saveState(state);
  return buildAllowOutput();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchRtWithFailOpen(
  state: PersistedSessionState,
  sessionId: string,
  toolName: string,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<number> {
  if (isRtCacheValid(state)) {
    return state.currentRt;
  }

  const signal = buildSignal(state, sessionId, toolName, {
    event_type: 'before_tool',
    priority: 'normal',
  }, config.frameworkTag ?? 'stable');

  try {
    const response = await withTimeout(
      client.sendSignal(signal),
      config.safetyGate.serverTimeoutMs
    );

    const rtData = PMatrixHttpClient.extractRtFromResponse(response);
    if (rtData) {
      state.currentRt = rtData.rt;
      state.currentMode = rtData.mode;
      state.grade = rtData.grade;
      state.rtCacheExpiry = buildRtCacheExpiry();

      if (config.debug) {
        process.stderr.write(
          `[P-MATRIX] R(t)=${rtData.rt.toFixed(3)} mode=${rtData.mode} grade=${rtData.grade}\n`
        );
      }
    }
  } catch {
    // fail-open: 캐시/기본값 사용, 차단하지 않음
    if (config.debug) {
      process.stderr.write(
        `[P-MATRIX] Server call failed/timeout — fail-open, using cached R(t)=${state.currentRt.toFixed(3)}\n`
      );
    }
  }

  return state.currentRt;
}

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  toolName: string,
  metadata: Record<string, unknown>,
  frameworkTag: 'beta' | 'stable',
  normDelta: number = 0.0,
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0.5,
    norm: normDelta,
    stability: 0.5,
    meta_control: 0.5,
    timestamp: new Date().toISOString(),
    signal_source: 'gemini_cli_hook',
    framework: 'gemini_cli',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      session_id: sessionId,
      tool_name: toolName,
      ...metadata,
    },
    state_vector: null,
  };
}

function buildAllowOutput(): GeminiBeforeToolOutput {
  // 빈 객체 = allow (Gemini CLI: decision 없으면 진행)
  return {};
}

function buildDenyOutput(reason: string): GeminiBeforeToolOutput {
  // L-5 검증 완료 포맷: { decision: 'deny', reason: '...' }
  return {
    decision: 'deny',
    reason,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout after ${ms}ms`)),
      ms
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}
