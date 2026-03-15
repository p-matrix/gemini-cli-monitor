# Changelog

All notable changes to `@pmatrix/gemini-cli-monitor` will be documented in this file.

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
