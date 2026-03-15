# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | Yes       |
| 0.1.x   | Yes       |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub Issues.**

If you discover a security vulnerability in `@pmatrix/gemini-cli-monitor`, please report it by emailing:

**architect@p-matrix.io**

Include the following in your report:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You will receive a response within **72 hours**. We will keep you informed of the progress and notify you when the issue is resolved.

## Scope

This policy covers:
- The `@pmatrix/gemini-cli-monitor` npm package
- The Gemini CLI hook runtime (Safety Gate, Credential Scanner, Kill Switch)
- The P-MATRIX server API (`api.pmatrix.io`)

## Out of Scope

- Vulnerabilities in Gemini CLI itself (report to [Google](https://github.com/google-gemini/gemini-cli/issues))
- The content of agents monitored by this plugin
- Third-party dependencies (report to the respective maintainers)

## Security Design Notes

`@pmatrix/gemini-cli-monitor` is designed to be **content-agnostic**:
- LLM prompts and responses are never transmitted to P-MATRIX servers
- Credential scanning runs entirely on-device
- Pattern-based blocks (`rm -rf`, `sudo rm`, `curl | sh`) have no network dependency
- Data sharing is **opt-in** and transmits only numerical behavioral metadata

For full privacy details, see the [README](README.md).
