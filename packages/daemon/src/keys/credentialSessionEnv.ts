import { decryptSecret } from "./envelope.js";

/**
 * Narrow structural seam onto `Db` (mirrors `connections/store.ts`'s `ConnectionsDbStore`) so this
 * resolver is unit-testable without a real database. The real `Db` class satisfies this via
 * `listCredentialSessionEnvSources`.
 */
export interface CredentialSessionEnvDbStore {
  listCredentialSessionEnvSources(
    projectId: string,
  ): Array<{ id: string; credentialEnvVar: string; secretBlob: string; answeredAt: string }>;
}

/**
 * Code-review finding (card 82b22817, post-gate): `{...credentialEnv, ...opts.sessionEnv}` protects the
 * collision `sessionEnv` can win — it does NOT protect `buildSpawnEnv`'s OWN six vars (GIT_PAGER/PAGER/
 * GIT_TERMINAL_PROMPT/LOOM_WORKTREE/PYTHONIOENCODING/PYTHONUTF8, set on `env` BEFORE that merge) or
 * anything inherited from `process.env` (PATH, NODE_OPTIONS, HOME, …) — an agent-chosen `credentialEnvVar`
 * reaching `resolveCredentialSessionEnv` unvalidated can overwrite any of them, project-wide, permanently.
 * `question_ask` never hands an agent the SECRET (the human types it), but it does hand the agent the
 * env-var NAME — this closes that side door. Kept exact/prefix rather than importing buildSpawnEnv's own
 * literals (that file is claude-CLI-spawn-shaped; this module must stay decryption-only, no pty import).
 *
 * ⚠️ HONEST LIMIT (code-review round 2): the REGEX below is a strong guarantee — it bounds the shape of
 * every accepted name absolutely, no exceptions. The DENYLIST is NOT — it is a best-effort enumeration of
 * known code-injection/host-launch vectors (JS: NODE_OPTIONS, NODE_PATH; native: the LD_ and DYLD_
 * prefixes — Loom ships to Linux/macOS via `loomctl`, not just this Windows dev host; Loom's own: the
 * GIT_, LOOM_, PYTHON and CLAUDE_ prefixes) and will always be one unenumerated var behind. Adding a name
 * here narrows the gap; it never closes it.
 */
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV_VAR_EXACT = new Set([
  "PATH", "NODE_OPTIONS", "NODE_PATH", "HOME", "USERPROFILE", "PAGER", "CLAUDECODE",
]);
const RESERVED_ENV_VAR_PREFIXES = ["GIT_", "LOOM_", "PYTHON", "CLAUDE_", "LD_", "DYLD_"];

/** True for a well-formed, DENYLIST-CLEAR env-var name (see the honest-limit note above — the regex half
 *  is absolute, the denylist half is best-effort) — the ONE check shared by the ask-time rejection
 *  (`mcp/questionTool.ts`'s `buildQuestionAsk`) and the resolve-time backstop below, so a row written
 *  before validation existed (or by any future second writer) is still caught structurally, not just at
 *  the one point-in-time a caller happened to go through `question_ask`. */
export function isValidCredentialEnvVarName(name: string): boolean {
  if (!ENV_VAR_NAME_RE.test(name)) return false;
  const upper = name.toUpperCase();
  if (RESERVED_ENV_VAR_EXACT.has(upper)) return false;
  return !RESERVED_ENV_VAR_PREFIXES.some((p) => upper.startsWith(p));
}

/**
 * Card 82b22817 — deliver every answered, un-provisioned `type:"credential"` secret this project has
 * stored under a declared `credentialEnvVar` into a flat `{ENV_VAR: plaintext}` map, merged into a spawn's
 * env at `pty/host.ts`'s two `buildSpawnEnv` call sites. Excludes a row whose `provisionTarget` was set —
 * that secret lives in a Connection instead, gated by its own deliberate, owner-only profile-binding grant
 * (Direction B, card 12dc7fc9) — this path must never bypass that gate. Delivery scope is every role,
 * every session of the project (owner directive 2026-09-18), matching how `sessionEnv` already behaves.
 *
 * Fail-closed at EVERY layer (mirrors `resolveScopedConnectionSecret`): the DB read itself, a reserved/
 * malformed env-var name, and a corrupt/undecryptable blob are each caught and skip only their own row (or,
 * for the DB read, the whole project) — logged, never thrown — so nothing here can ever block a spawn.
 * Rows come oldest-answered-first, so a rotated key (same env-var name asked twice) naturally has its most
 * recent answer win here.
 */
export function resolveCredentialSessionEnv(db: CredentialSessionEnvDbStore, projectId: string): Record<string, string> {
  const env: Record<string, string> = {};
  let rows: ReturnType<CredentialSessionEnvDbStore["listCredentialSessionEnvSources"]>;
  try {
    rows = db.listCredentialSessionEnvSources(projectId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[credential-session-env] failed to read credential rows for project ${projectId}: ${(err as Error).message} — no credentials delivered this spawn.`);
    return env;
  }
  for (const row of rows) {
    if (!isValidCredentialEnvVarName(row.credentialEnvVar)) {
      // eslint-disable-next-line no-console
      console.error(`[credential-session-env] refusing to deliver reserved/invalid env-var name "${row.credentialEnvVar}" (question ${row.id}, project ${projectId}) — dropped, not delivered.`);
      continue;
    }
    try {
      env[row.credentialEnvVar] = decryptSecret(row.secretBlob);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[credential-session-env] failed to decrypt stored credential for "${row.credentialEnvVar}" ` +
          `(question ${row.id}, project ${projectId}): ${(err as Error).message} — dropped, not delivered.`,
      );
    }
  }
  return env;
}
