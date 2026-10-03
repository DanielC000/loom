import { randomUUID } from "node:crypto";
import { decryptSecret } from "./envelope.js";

/**
 * Narrow structural seam onto `Db` (mirrors `connections/store.ts`'s `ConnectionsDbStore`) so this
 * resolver is unit-testable without a real database. The real `Db` class satisfies this via
 * `listCredentialSessionEnvSources`. `id` here is a `delivered_credentials` row id (card af08f7e8) — NOT a
 * `questions` row id, since that card decoupled the two; a caller chasing this id back to a table must look
 * in `delivered_credentials`, not `questions`.
 *
 * Card f44cc187 widens this with the once-per-row undeliverable-notice gate: `markCredentialUndeliverableAndAudit`
 * returns `true` only the FIRST time it's called for a given row id (the real `Db` method's own doc has
 * the mechanics) and pairs that with the same durable-audit write every other orchestration event uses,
 * both inside ONE transaction so a thrown append can never leave the row marked with no audit trail. Stays
 * narrow/duck-typed rather than importing `OrchestrationEvent`'s full shape or the real `Db` type, for the
 * same "decryption-only, no pty import" testability reason the module doc below already gives for the
 * resolver itself.
 */
export interface CredentialSessionEnvDbStore {
  listCredentialSessionEnvSources(
    projectId: string,
  ): Array<{ id: string; credentialEnvVar: string; secretBlob: string; deliveredAt: string }>;
  markCredentialUndeliverableAndAudit(
    id: string,
    evt: {
      id: string;
      ts: string;
      managerSessionId: string;
      kind: "credential_undeliverable";
      detail: { deliveredCredentialId: string; projectId: string; credentialEnvVar: string; reason: "reserved-name" };
    },
  ): boolean;
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
 * GIT_, LOOM_, PYTHON and CLAUDE_ prefixes; Anthropic's own: ANTHROPIC_ — billing/API-redirect; network
 * interception: HTTP(S)_PROXY/ALL_PROXY/NO_PROXY and NODE_EXTRA_CA_CERTS) and will always be one
 * unenumerated var behind. Adding a name here narrows the gap; it never closes it.
 *
 * @decision f44cc187 — do not remove APPDATA/LOCALAPPDATA for having no single verified in-repo/Node-core
 *   consumer (weakest evidence of this widening): denying a name only blocks STORING a credential under
 *   it, so the cost of a low-confidence addition here is effectively zero.
 */
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV_VAR_EXACT = new Set([
  "PATH", "NODE_OPTIONS", "NODE_PATH", "HOME", "USERPROFILE", "PAGER", "CLAUDECODE",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY",
  "SHELL", "COMSPEC", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA",
]);
const RESERVED_ENV_VAR_PREFIXES = [
  "GIT_", "LOOM_", "PYTHON", "CLAUDE_", "LD_", "DYLD_", "ANTHROPIC_", "NPM_CONFIG_", "PIP_",
];

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
 * Card f44cc187 — the ask-time rejection text (`mcp/questionTool.ts`) used to hand-copy this denylist as a
 * literal string, which drifted the moment a name was added here without a matching edit there (exactly
 * the class of bug this card exists to fix). Built from the SAME two sets `isValidCredentialEnvVarName`
 * reads, sorted for a stable, diffable message — so the two can never again disagree about what's denied.
 */
export function describeReservedEnvVarNames(): string {
  const exact = [...RESERVED_ENV_VAR_EXACT].sort().join("/");
  const prefixes = RESERVED_ENV_VAR_PREFIXES.join("/");
  return `must not be ${exact} or start with ${prefixes}`;
}

/**
 * Card 82b22817 — deliver every un-provisioned, NOT-YET-REVOKED `type:"credential"` secret this project has
 * stored under a declared `credentialEnvVar` into a flat `{ENV_VAR: plaintext}` map, merged into a spawn's
 * env at `pty/host.ts`'s two `buildSpawnEnv` call sites. Excludes a row whose `provisionTarget` was set —
 * that secret lives in a Connection instead, gated by its own deliberate, owner-only profile-binding grant
 * (Direction B, card 12dc7fc9) — this path must never bypass that gate. Delivery scope is every role,
 * every session of the project (owner directive 2026-09-18), matching how `sessionEnv` already behaves.
 * Card af08f7e8 decoupled the SOURCE of these rows from `questions` into `delivered_credentials` and added
 * revocation — this function's own behavior/contract is unchanged by that, since `listCredentialSessionEnvSources`
 * already absorbed the difference (see that method's own doc).
 *
 * Fail-closed at EVERY layer (mirrors `resolveScopedConnectionSecret`): the DB read itself, a reserved/
 * malformed env-var name, and a corrupt/undecryptable blob are each caught and skip only their own row (or,
 * for the DB read, the whole project) — logged, never thrown — so nothing here can ever block a spawn.
 * Rows come oldest-delivered-first, so a rotated key (same env-var name asked twice) naturally has its most
 * recent delivery win here.
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
      // Card f44cc187: a deny-list widening can silently de-provision a row that was perfectly valid when
      // it was asked — markCredentialUndeliverableAndAudit gates BOTH this log and the durable audit event
      // on the SAME once-per-row boolean, inside ONE transaction, so a thrown append rolls the mark back
      // too (never a half-marked row with no audit trail) and neither re-fires on a later spawn/resume for
      // the same row — the dedupe survives a daemon restart. Best-effort: a mark/append fault must never
      // block delivery of this row's siblings (same fail-closed posture as every other failure mode in
      // this loop) — the console log below still fires unconditionally in that case, so the operator never
      // loses the ONE trace this card's own triage found missing.
      try {
        const marked = db.markCredentialUndeliverableAndAudit(row.id, {
          id: randomUUID(), ts: new Date().toISOString(), managerSessionId: "",
          kind: "credential_undeliverable",
          detail: { deliveredCredentialId: row.id, projectId, credentialEnvVar: row.credentialEnvVar, reason: "reserved-name" },
        });
        if (marked) {
          // eslint-disable-next-line no-console
          console.error(`[credential-session-env] refusing to deliver reserved/invalid env-var name "${row.credentialEnvVar}" (delivered credential ${row.id}, project ${projectId}) — dropped, not delivered. (logged once; see delivered-credentials list for ongoing status)`);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[credential-session-env] failed to record the undeliverable notice for "${row.credentialEnvVar}" (delivered credential ${row.id}, project ${projectId}): ${(err as Error).message}`);
      }
      continue;
    }
    try {
      env[row.credentialEnvVar] = decryptSecret(row.secretBlob);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[credential-session-env] failed to decrypt stored credential for "${row.credentialEnvVar}" ` +
          `(delivered credential ${row.id}, project ${projectId}): ${(err as Error).message} — dropped, not delivered.`,
      );
    }
  }
  return env;
}
