# Changelog

All notable changes to `@pmatrix/gemini-cli-monitor` will be documented in this file.

---

## [0.4.1] — 2026-05-21

### Changed

- **Migrate to `@pmatrix/core-sdk@^0.1.0`** — `PMatrixHttpClient` 와 공통 schema (5-layer Agent Host-Integration Adapter Contract v0.1)를 `@pmatrix/core-sdk` 로 위임. SDK 자체 substance 큰 폭 감소, API surface 변경 0 (consumer 영향 없음).

### Verification

- Fresh install: `node_modules/@pmatrix/core-sdk` 가 registry tarball 추출 confirmed (symlink=false / version=0.1.0)
- Tests: 230 PASS, regression 0 (R-X.4 lockstep verify, monorepo commit `d1a6d08`)

### Lockstep §6.3 v0.2

- `@pmatrix/core-sdk` 의존성을 caret range `^0.1.0` 으로 declared. Core SDK major bump 시 6 adapter SDK 동시 major bump 의무.

---

## [0.4.0] — 2026-04-27

### Added (Cross-cutting client 보강 — server Production Polish 정합)

- **Cross-cutting A — Error correlation logging**: HTTP 5xx 응답 body 의 error_id 추출 → stderr 안내 ("Support 문의 시 Error ID 함께 제공"). server Production Polish A error UX 정합.
- **Cross-cutting B — X-Request-ID 헤더**: outgoing request crypto.randomUUID() 송출 + response echo. server middleware (commit 533781f) 정합.
- **Cross-cutting C — Burst 429 handling**: Retry-After + escalating backoff (BURST_RETRY_DELAYS [1000, 5000, 30000]). server burst_rate_limit middleware 정합.

### Tests

- 신규 ~10 test files (`src/__tests__/`): safety-gate, state-store, credential-scanner, breach-support, client (cross-cutting 검증 포함), config, formatter, before-tool, after-tool, session.

---

## [0.3.0] — 2026-04-27

### Changed (BREAKING — Mode literal rename)

- **Phase R-5 Mode naming Gen1 → Gen2 names** (server-side parity per Spec §❷):
  `'A+1'` → `'normal'` / `'A+0'` → `'caution'` / `'A-1'` → `'alert'` /
  `'A-2'` → `'critical'` / `'A-0'` → `'halt'`
- **Affected APIs**: `SafetyMode` union type (`src/types.ts`), `rtToMode()`
  return values + Safety Gate matrix mode comparisons (`src/safety-gate.ts`),
  state-store mode field defaults, MCP `status` tool output
- **Migration**: consumers must update mode string comparisons
  (`mode === 'A-0'` → `mode === 'halt'` 등). Server protocol output 도
  Gen2 names 로 통합 (Backend Spec v1.53)

### Fixed (Phase R-6 SDK build hygiene)

- **breach-support.ts**: `getApprovalStatus()` 의 `noUncheckedIndexedAccess`
  TypeScript narrowing 부재 → `Object is possibly 'undefined'` 3건 fix
  (explicit local const + null check pattern)
- **field-node-runtime dependency**: `node_modules/@pmatrix/field-node-runtime`
  symlink 정합 (`npm install` 로 npm registry 0.2.0 정상 fetch)

---

## [0.2.1] — 2026-03-23

### Fixed

- **gemini-types.ts** — `GeminiAfterAgentInput.stop_hook_active` 타입을 `boolean` (required) → `boolean?` (optional)로 수정
  - Gemini CLI v0.34.0 이전 버전에서 AfterAgent retry path에 `stopHookActive` 미전파 가능했음
  - 핸들러의 기존 `?? false` 폴백과 타입 정의 불일치 해소
  - Gemini CLI v0.34.0 fix: *"propagate stopHookActive in AfterAgent retry path"* 대응

---

## [0.2.0] — 2026-03-15

### Added

- **4.0 Field Integration** — FieldNode + IPC poller + degraded SV (neutral 0.5 axes)
- `pmatrix_field_status` MCP tool (connected, peerCount, myPosture, fieldId)
- Plan Mode LOW 분류 (enter_plan_mode, exit_plan_mode)
- SDK SessionContext 방어 (session_id fail-open)
- SIGTERM/SIGINT graceful shutdown (FieldNode.stop)

### Changed

- `@pmatrix/field-node-runtime@^0.2.0` 의존성 추가
- Policy Engine KNOWN_LIMITATION 문서화

## [0.1.0] — 2026-03-13 — Initial GA Release

### Added

- **11 Gemini CLI hook handlers** (Sprint 1–6)
  - `SessionStart` / `SessionEnd` — session lifecycle, state file creation
  - `BeforeAgent` — Credential scan: 16 pattern types, blocks before agent call (`continue: false`)
  - `BeforeTool` — Safety Gate: tool risk classification + R(t) matrix + instant-block rules (`decision: "deny"`)
  - `AfterTool` — tool result metadata observation (key count, MCP flag)
  - `BeforeModel` — LLM parameter inspection (temperature, toolConfig mode, allowedFunctionNames)
  - `AfterModel` — token usage + safety ratings + streaming guard (finishReason)
  - `AfterAgent` — agent response length metadata
  - `BeforeToolSelection` — tool config mode observation (Gemini CLI exclusive hook)
  - `PreCompress` — context compression frequency → STABILITY nudge (+0.03)
  - `Notification` — Policy DENY observation → NORM compensation path (+0.03)

- **MCP server** (`pmatrix-gemini mcp`)
  - `pmatrix_status` — show Grade / R(t) / Mode / session counters
  - `pmatrix_grade` — show Trust Grade + P-score + history
  - `pmatrix_halt` — global Kill Switch (creates `~/.pmatrix/HALT`)

- **Setup CLI** (`pmatrix-gemini setup`)
  - Outputs hooks config block for `~/.gemini/settings.json` (user pastes manually)
  - Outputs MCP config block for `~/.gemini/settings.json`
  - Trust status check (`~/.gemini/trustedFolders.json`)
  - `--agent-id` / `--api-key` flags write to `~/.pmatrix/config.json`

- **Extension Gallery support**
  - `gemini-extension.json` manifest
  - `hooks/hooks.json` — 11-hook config in nested format
  - `GEMINI.md` — agent context injection

- **Kill Switch**
  - `~/.pmatrix/HALT` file — blocks all tool execution when present
  - Auto-HALT when R(t) ≥ `killSwitch.autoHaltOnRt` (default: 0.75)
  - Manual trigger via `pmatrix_halt` MCP tool

- **Privacy-first design (§5.4)**
  - LLM prompts, responses, tool results, and file contents are never transmitted
  - Only metadata (lengths, counts, types, durations) is sent to the server

### Known Limitations

- `BeforeToolSelection` filtering disabled in v1.0 (observation only — D-7 decision)
- Trust setup required per folder: run `gemini` in each project folder to activate hooks
- Windows project-level hooks: not supported (global-only for this release)
