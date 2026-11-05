/**
 * Leaf module (no imports — keeps `claude-settings-routing-scan.ts` free of a `pty/host.ts` import cycle).
 *
 * True for an env-var NAME that can redirect or re-bill a claude session: any `ANTHROPIC_*` (case-insensitive,
 * since Windows env names are) plus `AWS_BEARER_TOKEN_BEDROCK`. Deliberately NOT `AWS_*`/`GOOGLE_*`/proxy vars —
 * those have legitimate non-claude uses for every child and cannot divert claude without the (already
 * scrubbed) `CLAUDE_CODE_USE_*` switches. Card c8eeda93; re-exported by `pty/host.ts` (the spawn-env scrub).
 */
export function isAnthropicSpawnEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return upper.startsWith("ANTHROPIC_") || upper === "AWS_BEARER_TOKEN_BEDROCK";
}
