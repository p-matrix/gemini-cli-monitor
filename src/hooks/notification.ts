// =============================================================================
// @pmatrix/gemini-cli-monitor — hooks/notification.ts
// Notification hook handler — Policy Engine DENY 보상 경로 (관찰만, 차단 없음)
//
// 신규 (타 플랫폼 없음 — Gemini CLI 고유 훅)
//
// L-1 Known Limitation:
//   Gemini CLI 내장 Policy가 BeforeTool 전에 DENY 처리하면 BeforeTool 훅이 발화되지 않는다.
//   Notification(ToolPermission)은 이 경우의 보상 관찰 경로 — Policy DENY를 간접 감지.
//
// 처리 흐름:
//   1. notification_type === 'ToolPermission' → policyDenyCount++
//   2. norm delta +0.03 (Policy Engine DENY = 규범 위반 간접 신호)
//   3. message / details 내용 미접근 (메시지 길이만 허용)
//   4. return {} (관찰만, 차단 없음)
// =============================================================================

import { PMatrixConfig, SignalPayload } from '../types';
import { PMatrixHttpClient } from '../client';
import { GeminiNotificationInput, GeminiNotificationOutput } from '../gemini-types';
import {
  loadOrCreateState,
  saveState,
  PersistedSessionState,
} from '../state-store';

export async function handleNotification(
  event: GeminiNotificationInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<GeminiNotificationOutput> {
  const { session_id, notification_type, message, details } = event;

  const state = loadOrCreateState(session_id, config.agentId);

  // notification_type === 'ToolPermission' → Policy Engine DENY 보상 경로
  const isToolPermission = notification_type === 'ToolPermission';
  if (isToolPermission) {
    state.policyDenyCount += 1;
  }

  // message / details 내용 미접근 — 길이(구조적 메타데이터)만 허용
  const messageLength = typeof message === 'string' ? message.length : 0;
  const detailsKeyCount =
    details && typeof details === 'object' ? Object.keys(details).length : 0;

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] notification: type=${notification_type} policyDenyCount=${state.policyDenyCount}\n`
    );
  }

  // norm delta +0.03 — ToolPermission = Policy DENY 간접 신호 (§8 Notification)
  const normDelta = isToolPermission ? 0.03 : 0.0;

  const signal = buildSignal(
    state, session_id,
    notification_type, messageLength, detailsKeyCount,
    config.frameworkTag ?? 'stable', normDelta
  );
  client.sendSignal(signal).catch(() => {});

  saveState(state);

  // Notification stdout: suppressOutput + systemMessage만 허용
  return {};
}

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  notificationType: string,
  messageLength: number,
  detailsKeyCount: number,
  frameworkTag: 'beta' | 'stable',
  normDelta: number,
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
      event_type: 'notification',
      session_id: sessionId,
      notification_type: notificationType,
      // message 원문 미포함 — 길이만 (Content-Agnostic)
      message_length: messageLength,
      details_key_count: detailsKeyCount,
      policy_deny_count: state.policyDenyCount,
      priority: 'normal',
    },
    state_vector: null,
  };
}
