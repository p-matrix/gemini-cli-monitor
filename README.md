# @pmatrix/gemini-cli-monitor

Runtime safety governance for Gemini CLI — **11-hook observability + tool-level enforcement.**

Analyzes tool calls before execution, detects credential leaks in prompts, and continuously measures agent risk with live Trust Grade (A–E).

> Requires a P-MATRIX account and API key.

---

## What it does

### Core Protection

- **Safety Gate** (`BeforeTool`) — Tool call analysis before execution. Blocks based on current risk level R(t) and instant-block rules (rm -rf, sudo rm, curl|sh, base64|sh).
- **Credential Protection** (`BeforeAgent`) — Detects and blocks 16 types of API keys and secrets before they reach the agent.
- **Kill Switch** — Automatically halts when R(t) ≥ 0.75. Manually via `pmatrix_halt` MCP tool. Creates `~/.pmatrix/HALT` to block all sessions.

### Behavioral Intelligence

- **11 Gemini CLI hooks → 4-axis signal mapping** (BASELINE / NORM / STABILITY / META_CONTROL)
- **BeforeModel** — LLM parameter inspection (temperature, toolConfig mode): META_CONTROL signal
- **AfterModel** — Token usage + safety ratings observation: STABILITY signal
- **BeforeToolSelection** — Tool config mode observation (Gemini CLI exclusive hook)
- **PreCompress** — Context compression frequency → STABILITY nudge (+0.03)
- **Notification** — Policy DENY observation → NORM compensation path

---

## Requirements

| Requirement | Version |
|-------------|---------|
| Node.js | >= 18 |
| Gemini CLI | 0.26.0+ |
| P-MATRIX server | v1.0.0+ |

---

## Installation

### npm (advanced users / CI)

```bash
npm install -g @pmatrix/gemini-cli-monitor

# Get your API key at app.pmatrix.io
export PMATRIX_API_KEY=pm_live_xxxxxxxxxxxx
pmatrix-gemini setup --agent-id <YOUR_AGENT_ID>
```

Follow the printed instructions to add the hooks and MCP config to `~/.gemini/settings.json`, then restart Gemini CLI.

### Extension Gallery (recommended)

```bash
gemini extensions install github.com/p-matrix/gemini-cli-monitor
```

---

## Trust Setup

Gemini CLI only runs hooks in **trusted folders**. Before hooks will execute, you must trust the folder:

1. Run `gemini` in your project folder
2. Accept the trust prompt when asked
3. Verify trust status: `pmatrix-gemini setup`

---

## Privacy

**Content-Agnostic:** P-MATRIX never collects, parses, or stores your prompts, LLM responses, tool results, or file contents.

- `BeforeAgent` — credential scanning runs locally; only detection counts are sent (never prompt content)
- `BeforeTool` — sends `tool_name` and risk classification only (never tool arguments)
- `AfterTool` — sends `response_key_count` only (never tool result content)
- `BeforeModel` — sends temperature, toolConfig.mode, allowedFunctionNames.length only (never messages)
- `AfterModel` — sends finishReason, safetyRatings, usageMetadata only (never response text)

---

## Hooks Registered (11)

| Hook | Type | Purpose |
|------|------|---------|
| `SessionStart` | Observation | Session lifecycle, baseline signal |
| `SessionEnd` | Observation | Session lifecycle |
| `BeforeAgent` | **Blocking** | Credential scan |
| `BeforeTool` | **Blocking** | Safety Gate |
| `AfterTool` | Observation | Tool result metadata |
| `BeforeModel` | Observation | LLM parameter inspection |
| `AfterModel` | Observation | Token usage + safety ratings |
| `AfterAgent` | Observation | Agent response metadata |
| `BeforeToolSelection` | Observation | Tool config mode |
| `PreCompress` | Observation | Context compression tracking |
| `Notification` | Observation | Policy DENY compensation path |

---

## Safety Gate Matrix

| Risk Level | Mode | HIGH-risk | MEDIUM-risk | LOW-risk |
|-----------|------|-----------|-------------|----------|
| < 0.15 | Normal | Allow | Allow | Allow |
| 0.15–0.30 | Caution | **Block** | Allow | Allow |
| 0.30–0.50 | Alert | **Block** | Allow | Allow |
| 0.50–0.75 | Critical | **Block** | **Block** | Allow |
| >= 0.75 | Halt | **Block** | **Block** | **Block** |

**Instant block rules** (regardless of R(t)):
- `sudo rm` / `sudo mkfs` / `sudo dd` — privilege escalation + destructive
- `rm -rf <non-tmp path>` — destructive deletion
- `curl ... | sh` — remote code execution
- `base64 --decode ... | sh` — obfuscated RCE
- `write_file` to system paths (`/etc/`, `/sys/`, `/boot/`, etc.) — HIGH risk

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `pmatrix_status` | Show current Grade, R(t), mode, and session counters |
| `pmatrix_grade` | Show behavioral grade and recent history |
| `pmatrix_halt` | Manually trigger Kill Switch |

> To resume from halt: `rm ~/.pmatrix/HALT`

---

## Known Limitations (v0.1.0)

| Issue | Cause | Status |
|-------|-------|--------|
| `BeforeToolSelection` filtering disabled | Over-intervention risk (D-7) | Observation only in v1.0 |
| `pmatrix_*` MCP tools are self-exempt | By design | Early allow prevents recursion |

---

## Advanced Configuration

Edit `~/.pmatrix/config.json`:

```json
{
  "serverUrl": "https://api.pmatrix.io",
  "agentId": "gem_YOUR_AGENT_ID",
  "apiKey": "pm_live_xxxxxxxxxxxx",
  "safetyGate": { "enabled": true, "serverTimeoutMs": 2500 },
  "credentialProtection": { "enabled": true },
  "killSwitch": { "autoHaltOnRt": 0.75 },
  "dataSharing": false,
  "debug": false
}
```

---

## Offline / Server-Down Behavior

- **No cache**: R(t) = 0.0 (fail-open)
- **Cache + server down**: Last known R(t) maintained
- **Server timeout (> 2,500 ms)**: Fail-open — tool call allowed
- **`~/.pmatrix/HALT` exists**: All tool calls blocked regardless of server state

---

## Dashboard

Production server: `https://api.pmatrix.io`
Dashboard: `https://app.pmatrix.io`

- **Story tab** — R(t) trajectory timeline, mode transitions, tool block events
- **Analytics tab** — Grade history, stability trends
- **Logs tab** — Live session events, audit trail

---

## License

Apache-2.0 © 2026 P-MATRIX
