// Client-side mirror of the daemon's `passEnv` validation, for the Capabilities Settings panel's
// per-row editor. SOURCE OF TRUTH, mirrored rule for rule: `validatePassEnv` /
// `passEnvReservedReason` / `ENV_KEY_NAME_RE` / `PASS_ENV_MAX_KEYS` in
// packages/daemon/src/capabilities/registry.ts.
//
// ⛔ THE SERVER STAYS AUTHORITATIVE — nothing here is a permission. This only catches a typo at the
// keystroke instead of a round-trip; a refused PATCH's own `{ error }` is rendered verbatim.
// ⛔ Don't let the two drift: these rules are COPIED because they live in @loom/daemon, which web
// cannot depend on. packages/web/test/pass-env.mjs pins the mirrored messages byte-for-byte. If they
// ever move into @loom/shared, DELETE this mirror and import them — never keep two.
//
// The array validator reproduces the server's MESSAGE TEXT too, so a pre-flight block reads
// identically to the 400 it prevents. `passEnvEntryError` is the one deliberate departure (see it).

/** Mirror of the daemon's `ENV_KEY_NAME_RE` — a plain POSIX-style identifier, nothing else. */
export const ENV_KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Mirror of the daemon's `PASS_ENV_MAX_KEYS`. */
export const PASS_ENV_MAX_KEYS = 32;

const PASS_ENV_RESERVED_PREFIXES = ["CLAUDE_CODE_", "LOOM_"];
const PASS_ENV_RESERVED_EXACT = ["LOOM_MCP_TOKEN"];

/**
 * Mirror of the daemon's `passEnvReservedReason`: the names an owner may never forward, ON TOP of the
 * charset check — Loom's own per-session credential and claude's own control vars, both of which a
 * strict-shape regex alone would happily accept.
 *
 * The exact-match arm is checked FIRST and `LOOM_MCP_TOKEN` is also covered by the `LOOM_` prefix —
 * same deliberate redundancy, same order, as the server, so the two can never return different text
 * for the same input.
 */
export function passEnvReservedReason(name: string): string | null {
  const upper = name.toUpperCase();
  if (PASS_ENV_RESERVED_EXACT.includes(upper)) return `'${name}' is a reserved Loom credential name`;
  for (const prefix of PASS_ENV_RESERVED_PREFIXES) {
    if (upper.startsWith(prefix)) return `'${name}' matches the reserved '${prefix}*' prefix`;
  }
  return null;
}

/**
 * Mirror of the daemon's `validatePassEnv`, including its message strings and its SILENT DEDUPE (a
 * repeated name is collapsed, never rejected — see `duplicatePassEnvIndexes` for how the editor
 * discloses that instead of letting a row vanish on save without explanation).
 *
 * `undefined` ⇒ `[]`, exactly as the server treats an absent key. Note this is NOT the same as the
 * PATCH route's own `requirePassEnvKey` check, which rejects a body that never NAMES `passEnv` —
 * that one guards against a typo'd key silently clearing the list, and the panel always sends the key.
 */
export function validatePassEnv(v: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: [] };
  if (!Array.isArray(v) || v.length > PASS_ENV_MAX_KEYS) {
    return { ok: false, error: `passEnv must be an array of at most ${PASS_ENV_MAX_KEYS} env var names` };
  }
  const seen = new Set<string>();
  for (const entry of v) {
    if (typeof entry !== "string" || !ENV_KEY_NAME_RE.test(entry)) {
      return { ok: false, error: `passEnv entry ${JSON.stringify(entry)} is not a valid env var name` };
    }
    const reason = passEnvReservedReason(entry);
    if (reason) return { ok: false, error: `passEnv entry rejected: ${reason}` };
    seen.add(entry);
  }
  return { ok: true, value: [...seen] };
}

/**
 * The per-row message for ONE name, for a hint rendered beside that name's own input.
 *
 * Deliberately NOT the array validator's wording: "passEnv entry \"8BALL\" is not a valid env var name"
 * restates which entry was at fault, which the row's position already says, and never says what a legal
 * name looks like. The reserved arm reuses the server's own sentence verbatim — it is already a
 * complete, readable explanation.
 *
 * Returns null for a name the server would accept, and for the EMPTY string: a blank row is an
 * unfinished one, not an error to shout about. The caller drops blanks before validating the array.
 */
export function passEnvEntryError(name: string): string | null {
  if (name === "") return null;
  if (!ENV_KEY_NAME_RE.test(name)) {
    return "Not a valid env var name — letters, digits and underscores only, and not starting with a digit.";
  }
  return passEnvReservedReason(name);
}

/**
 * The indexes of every name that REPEATS one earlier in the list (the first occurrence is not flagged).
 *
 * The server accepts duplicates and silently collapses them, so this is disclosure, not validation: the
 * editor marks the later row as redundant and leaves Save enabled. Without it a human adds the same
 * name twice, saves, and one of their rows simply disappears with nothing having said why.
 */
export function duplicatePassEnvIndexes(names: string[]): Set<number> {
  const seen = new Set<string>();
  const dupes = new Set<number>();
  names.forEach((name, i) => {
    if (name === "") return;
    if (seen.has(name)) dupes.add(i);
    else seen.add(name);
  });
  return dupes;
}
