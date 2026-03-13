// =============================================================================
// @pmatrix/gemini-cli-monitor — credential-scanner.ts
// Credential detection scanner — 100% reuse from @pmatrix/claude-code-monitor
// =============================================================================

interface CredentialPattern {
  name: string;
  pattern: RegExp;
}

const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  { name: 'OpenAI Project Key', pattern: /sk-proj-[A-Za-z0-9\-_]{20,}/ },
  { name: 'OpenAI Legacy Key', pattern: /sk-(?!proj-|ant-|test-|fake-)[A-Za-z0-9]{20,}/ },
  { name: 'Anthropic Key', pattern: /sk-ant-[A-Za-z0-9\-]{40,}/ },
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub Token', pattern: /ghp_[A-Za-z0-9]{36}/ },
  { name: 'GitHub Fine-grained Token', pattern: /github_pat_[A-Za-z0-9_]{82}/ },
  { name: 'Private Key (PEM)', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Database URL', pattern: /(?:postgresql|mysql):\/\/[^:\s]+:[^@\s]+@/ },
  { name: 'Password in Context', pattern: /password\s*[:=]\s*["']?[^\s"']{8,}/i },
  { name: 'Bearer Token', pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9\-_.]{20,}/ },
  { name: 'Google AI Key', pattern: /AIza[0-9A-Za-z\-_]{35}/ },
  { name: 'Stripe Secret Key', pattern: /sk_(?:live|test)_[A-Za-z0-9]{24,}/ },
  { name: 'Slack Token', pattern: /xox[bpras]-[A-Za-z0-9\-]{10,}/ },
  { name: 'npm Token', pattern: /npm_[A-Za-z0-9]{36}/ },
  { name: 'SendGrid Key', pattern: /SG\.[A-Za-z0-9\-_]{22,}\.[A-Za-z0-9\-_]{22,}/ },
  { name: 'Discord Bot Token', pattern: /[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9\-_]{6}\.[A-Za-z0-9\-_]{27,}/ },
] as const;

const TEST_EXCLUSIONS = [
  'sk-test-',
  'sk-fake-',
  'example',
  'your-api-key-here',
  'EXAMPLE',
  'placeholder',
  '<YOUR_',
  'INSERT_',
  'REPLACE_',
] as const;

interface ScanResult {
  name: string;
  count: number;
}

export function scanCredentials(
  text: string,
  customPatterns: readonly string[] = []
): ScanResult[] {
  if (!text) return [];

  const stripped = removeCodeBlocks(text);

  const patterns: CredentialPattern[] = [...CREDENTIAL_PATTERNS];
  for (const rawPattern of customPatterns) {
    try {
      patterns.push({ name: 'Custom Pattern', pattern: new RegExp(rawPattern) });
    } catch (err) {
      process.stderr.write(
        `[P-MATRIX] credential-scanner: invalid custom pattern skipped — ${(err as Error).message}\n`
      );
    }
  }

  const results: ScanResult[] = [];

  for (const { name, pattern } of patterns) {
    try {
      const globalPattern = new RegExp(pattern.source, 'g');
      const matches = stripped.match(globalPattern);
      if (!matches) continue;

      const realMatches = matches.filter((m) => !isTestValue(m));
      if (realMatches.length > 0) {
        results.push({ name, count: realMatches.length });
      }
    } catch (err) {
      process.stderr.write(
        `[P-MATRIX] credential-scanner: pattern execution failed for "${name}" — ${(err as Error).message}\n`
      );
    }
  }

  return results;
}

function removeCodeBlocks(text: string): string {
  let result = text.replace(/`[^`\n]+`/g, '[INLINE_CODE]');
  result = result.replace(/```[\s\S]*?```/g, '[CODE_BLOCK]');
  result = result.replace(/~~~[\s\S]*?~~~/g, '[CODE_BLOCK]');
  return result;
}

function isTestValue(match: string): boolean {
  for (const exclusion of TEST_EXCLUSIONS) {
    if (match.includes(exclusion)) return true;
  }
  return false;
}
