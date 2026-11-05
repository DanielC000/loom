import type { CodexProvider } from "@loom/shared";
import { isLoopbackBindHost } from "../gateway/trust-tier.js";

/**
 * Card `2ef54430` — the pure rules for a Profile's human-only codex model-provider endpoint. One module so the
 * save-time validator (`profiles/validate.ts`), the spawn-time argv builder (`pty/codex-host.ts`) and the
 * tests all read the SAME constants and predicates (no hand-copied second list to drift).
 *
 * @decision 2ef54430 — the API key is NEVER on the Profile or an argv: `connectionId` names a stored
 * Connection, its secret rides the codex child's env as {@link CODEX_PROVIDER_KEY_ENV_VAR} only, and the URL
 * must be https (or http to loopback) with its host equal to the connection's host. Do not widen either rule.
 */

/** The fixed, Loom-owned env var the codex child reads the provider key from (`env_key`). `LOOM_` is already
 *  denylisted for stored credentials, so no user credential can shadow it. */
export const CODEX_PROVIDER_KEY_ENV_VAR = "LOOM_CODEX_PROVIDER_KEY";

/** codex's built-in LOCAL provider ids that take no base_url/key. `openai` is reserved too but is not
 *  selectable here (it is codex's own default). */
export const CODEX_BUILTIN_PROVIDER_IDS: readonly string[] = ["ollama", "lmstudio"];
const CODEX_RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set(["openai", ...CODEX_BUILTIN_PROVIDER_IDS]);

export const CODEX_PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const CODEX_PROVIDER_URL_MAX = 512;
/** Anything that could break out of a TOML basic string or a single argv element. */
const UNSAFE_URL_CHARS_RE = /["\\\u0000- \u007f]/;

export function isBuiltinCodexProviderId(id: string): boolean {
  return CODEX_BUILTIN_PROVIDER_IDS.includes(id);
}

/** Lowercased hostname of a URL or bare-host string (`host`, `host:port`, `https://host/path`); null when
 *  unparseable. IPv6 keeps its brackets (URL's own spelling) on both sides of any comparison. */
export function endpointHostname(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    const h = u.hostname.toLowerCase().replace(/\.$/, "");
    return h || null;
  } catch {
    return null;
  }
}

export function isLoopbackHostname(h: string): boolean {
  // Delegates to trust-tier's single loopback predicate (remote-trust-single-predicate-guard forbids a second
  // loopback literal list). URL.hostname spells IPv6 with brackets; the predicate wants it bare. Not a trust
  // decision: this only picks which URLs a human may save.
  return isLoopbackBindHost(h.replace(/^\[|\]$/g, ""));
}

/** Pure shape check (no DB). Returns an error string, or null when the selection is well-formed. */
export function codexProviderShapeError(p: CodexProvider): string | null {
  if (typeof p.id !== "string" || !CODEX_PROVIDER_ID_RE.test(p.id)) {
    return `codexProvider.id must match ${CODEX_PROVIDER_ID_RE} (lowercase letters, digits, "_" or "-")`;
  }
  if (isBuiltinCodexProviderId(p.id)) {
    if (p.baseUrl !== undefined || p.connectionId !== undefined) {
      return `codexProvider "${p.id}" is a codex built-in local provider: it takes no baseUrl and no connectionId`;
    }
    return null;
  }
  if (CODEX_RESERVED_PROVIDER_IDS.has(p.id)) {
    return `codexProvider.id "${p.id}" is a reserved codex provider id and cannot be overridden — pick another id`;
  }
  if (!p.baseUrl || !p.connectionId) {
    return `a custom codexProvider needs both baseUrl and connectionId (the stored Connection holding the API key)`;
  }
  return codexProviderUrlError(p.baseUrl);
}

export function codexProviderUrlError(raw: string): string | null {
  if (raw.length > CODEX_PROVIDER_URL_MAX) return `codexProvider.baseUrl must be at most ${CODEX_PROVIDER_URL_MAX} characters`;
  // codex is launched through its Windows `.cmd` shim, where cmd.exe expands `%VAR%` (and treats `^` as an
  // escape) inside any argument: a `%LOOM_CODEX_PROVIDER_KEY%` in the path would send the key to the provider
  // host. Rejected wholesale, which also rules out legitimately percent-encoded paths — accepted.
  if (/[%^]/.test(raw)) return "codexProvider.baseUrl must not contain '%' or '^' (Windows cmd.exe would expand them inside the launch command, which could leak environment values such as the key into the URL); this also rules out percent-encoded paths";
  if (UNSAFE_URL_CHARS_RE.test(raw)) return "codexProvider.baseUrl must not contain whitespace, control characters, quotes or backslashes";
  let u: URL;
  try { u = new URL(raw); } catch { return "codexProvider.baseUrl is not a valid absolute URL"; }
  if (u.username || u.password) return "codexProvider.baseUrl must not embed credentials (user:pass@) — the key lives in the Connection";
  if (u.search || u.hash) return "codexProvider.baseUrl must not carry a query string or fragment";
  const host = u.hostname.toLowerCase();
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && isLoopbackHostname(host)) return null;
  return "codexProvider.baseUrl must be https:// (plain http:// is allowed only to a loopback host)";
}

/** The slice of the connections store the binding check reads (mirrors `CapabilityGrantBindingDbStore`). */
export interface CodexProviderBindingDbStore {
  getConnection(id: string): { host: string; authScheme: string } | undefined | null;
}

/**
 * Connection-binding check, run by the REST handlers after the shape passes. The connection must exist, be an
 * `api-key`/`bearer` row (the only schemes `getSecretForUse` decrypts), and its host must equal the baseUrl's
 * host — both normalised through {@link endpointHostname} (a Connection stores a free-form host string, a bare
 * host or a URL; the port is deliberately ignored). Fail-closed: an unparseable host is a mismatch.
 */
export function codexProviderBindingError(p: CodexProvider, db: CodexProviderBindingDbStore): string | null {
  if (!p.connectionId || !p.baseUrl) return null; // built-in id: nothing to bind (shape check owns that)
  const conn = db.getConnection(p.connectionId);
  if (!conn) return `codexProvider.connectionId "${p.connectionId}" names no stored Connection`;
  if (conn.authScheme !== "api-key" && conn.authScheme !== "bearer") {
    return `codexProvider.connectionId must name an api-key or bearer Connection (this one is "${conn.authScheme}")`;
  }
  const want = endpointHostname(p.baseUrl);
  const have = endpointHostname(conn.host);
  if (!want || !have || want !== have) {
    return `codexProvider.baseUrl host (${want ?? "unparseable"}) must equal the Connection's host (${have ?? "unparseable"}) — the key may only be sent to the host it was stored for`;
  }
  return null;
}
