/**
 * Agent-tooling P4: the capability registry — generalizes the two hard-coded per-session MCPs
 * (Playwright/markitdown) into a small, extensible, owner-curated catalog. This module owns the
 * OWNER-ADDED half only: CRUD against the `capability_defs` table, input validation, the GENERIC
 * provisioning dispatch (node-package | python-venv | bundled | command — the fourth kind, an
 * owner-typed arbitrary `command`, is OWNER-APPROVED as owner-typed-therefore-trusted, the same trust
 * model as `gateCommand`: trust is about who-can-set, not sandboxing what's set — PLUS `github-binary`, a
 * SEED-ONLY fifth kind for the bundled "github" capability's Loom-managed downloaded binary, never
 * owner-typeable via `validateCapabilityDefInput`), and a PER-SLUG provisioning tracker shared by
 * python-venv AND github-binary (so N provisioning capabilities — of either kind — provision independently,
 * never sharing one in-flight flag).
 *
 * The BUILTIN capabilities (browser-testing/document-conversion) are NOT rows in this
 * table — they stay special-cased in `buildMcpServers` (pty/host.ts), reusing their existing,
 * already-hardened resolution code (`playwrightMcpServer`/`markitdownMcpServer`)
 * UNTOUCHED. Their reserved slugs are
 * rejected here (`RESERVED_CAPABILITY_SLUGS`) so an owner can never shadow/rename over them.
 *
 * CREDENTIAL TIE (agent-tooling P4 OQ1): a capability with `requiresConnection` gets its bound P1
 * connection's DECRYPTED secret injected ONLY into the resolved MCP server's own `env` block (never a
 * CLI argument — argv is visible in process listings; never reaching the `claude` process or a tool
 * argument). `secretEnvVar` names which env var the owner's chosen MCP server expects the credential
 * under (e.g. "GITHUB_TOKEN"); it defaults to `LOOM_CAPABILITY_SECRET` when unset.
 *
 * P4↔P5a interaction (oauth2): this static env-injection tie is fundamentally incompatible with an
 * `oauth2` connection — `getSecretForUse` (connections/store.ts) returns undefined for an oauth2 row BY
 * DESIGN (oauth2 must flow through refresh-on-use via the P2 `authenticated_request` tool, never a
 * static token that goes stale with no refresh path), so `resolveCapabilityServer` below correctly mounts
 * with NO env block when the resolved `connectionSecret` is undefined. That's the intended fail-closed
 * runtime behavior; the human-facing guard against it happening BY ACCIDENT (an owner binding an oauth2
 * connection to a `requiresConnection` grant and expecting it to work) lives at bind time instead —
 * `profiles/validate.ts` › `capabilityGrantBindingError`, enforced in the profile REST handlers.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { CapabilityProvisionKind, CapabilitySummary } from "@loom/shared";
import { loomVenvBin, ensurePythonPackageAsync } from "../python/venv.js";
import type { EnsurePythonPackageOpts, EnsurePythonResult, ProvisionOutcome } from "../python/venv.js";
import { loomGithubMcpBin, ensureGithubMcpBinaryAsync } from "./github-binary.js";
import type { EnsureGithubBinaryOpts, EnsureGithubBinaryResult, GithubBinaryProvisionOutcome } from "./github-binary.js";
import { loomNpmPinnedBin, ensureNpmPinnedAsync, validateNpmPinnedSpec } from "./npm-pinned.js";
import type { EnsureNpmPinnedOpts, EnsureNpmPinnedResult, NpmPinnedProvisionOutcome } from "./npm-pinned.js";
import { resolveExecutable } from "../pty/resolve-bin.js";
import { LOOM_FIRST_PARTY_SERVER_IDS } from "../pty/tool-attribution.js";

/** One owner-added catalog row as stored/read at the DB layer (mirrors ConnectionRow's shape). */
export interface CapabilityDefRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  transport: "stdio" | "http";
  kind: CapabilityProvisionKind;
  /** Kind-specific recipe (JSON-serialized {@link CapabilityProvision}). */
  provisionJson: string;
  /** JSON string[] of MCP tool names this capability contributes to --allowedTools. */
  toolAllowlistJson: string;
  wantsScratchDir: boolean;
  requiresConnection: boolean;
  /** Env var name the credential is injected under when requiresConnection; null when not applicable. */
  secretEnvVar: string | null;
  /**
   * Card fafae623: HUMAN-ONLY (never agent-writable, never set on a seed row — github-binary's seed
   * row always gets `[]`) extra env KEY NAMES this ONE capability's env-isolating launcher should also
   * forward from its own inherited env, beyond the fixed base allowlist. The escape hatch for an
   * owner-added `command`/`python-venv` tool that relies on an AMBIENT daemon-host env var (exported by
   * the owner, outside Loom's `secretEnvVar` delivery mechanism) — without this, such a tool silently
   * stops seeing that var once every stdio mount is isolated. Validated by {@link validatePassEnv} —
   * a strict env-name regex plus {@link passEnvReservedReason}'s denylist; defaults to `[]`.
   */
  passEnv: string[];
  createdAt: string;
}

/** The narrow db surface this module needs (mirrors ConnectionsDbStore's shape in connections/store.ts). */
export interface CapabilitiesDbStore {
  listCapabilityDefs(): CapabilityDefRow[];
  getCapabilityDefBySlug(slug: string): CapabilityDefRow | undefined;
  createCapabilityDef(input: Omit<CapabilityDefRow, "id" | "createdAt">): CapabilityDefRow;
  deleteCapabilityDef(id: string): void;
  /** Card fafae623: update only `passEnv` on an existing row, returning the updated row — `undefined`
   *  when `id` doesn't name an existing row (never throws; the caller maps that to a descriptive Error). */
  updateCapabilityDefPassEnv(id: string, passEnv: string[]): CapabilityDefRow | undefined;
}

export type CapabilityProvision =
  | { kind: "node-package"; package: string; binRelativeToPackageJson: string }
  | { kind: "python-venv"; packages: string[]; binary: string; probeImport?: string }
  // `outputDirEnvVar`: the ONLY wantsScratchDir mechanism a bundled/command MCP has besides the
  // node-package branch's hardcoded `--output-dir` CLI arg (below) — some CLIs (e.g. the image-gen seed)
  // take their output directory via an env var of their OWN choosing instead of a flag. Optional + additive:
  // omitted ⇒ byte-identical to before this field existed (no scratch dir is ever injected for that row).
  | { kind: "bundled"; command: string; args?: string[]; outputDirEnvVar?: string }
  | { kind: "command"; command: string; args?: string[]; outputDirEnvVar?: string }
  | { kind: "github-binary"; version: string }
  // `binRelativeToPackageJson` mirrors node-package's field — the real npm package's own "bin" value,
  // hardcoded at seed-authoring time (never read from the installed package.json at runtime).
  // `outputDirEnvVar` mirrors bundled/command's field (card e7d6e43b migrates "image-gen" onto this kind
  // and it needs its existing NANO_BANANA_OUTPUT_DIR scratch-dir injection to keep working).
  | { kind: "npm-pinned"; package: string; version: string; binRelativeToPackageJson: string; outputDirEnvVar?: string };

const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The legacy-bridged slugs (@loom/shared's `LEGACY_CAPABILITY_SLUGS`) — reserved so an owner-added
 *  row can never collide with or shadow a builtin. Duplicated as string literals (not imported) to keep
 *  this module's validation independent of the shared bridge helper's own location.
 *
 *  Card a6598c1e: ALSO reserves every Loom first-party MCP server id (`LOOM_FIRST_PARTY_SERVER_IDS`,
 *  derived — never hand-typed — from `pty/tool-attribution.ts`'s own constants). Without this, an
 *  owner-created capability slugged e.g. `loom-tasks` would overwrite Loom's own mount in
 *  `buildMcpServers` (last-write-wins on `mcpServers[def.slug] = server`) and the replacement would
 *  inherit `loom-tasks`'s universal `BASELINE_SESSION_ALLOW` auto-approval.
 *
 *  @decision 42e9caf9 — reserve the REAL `mcpServers` map key `buildMcpServers` (pty/host.ts) mounts a
 *  builtin under (`"playwright"`/`"markitdown"`/`"codescape"`), never just its grant slug — the two can
 *  differ, and an unreserved mount key lets an owner-added capability silently shadow it. */
export const RESERVED_CAPABILITY_SLUGS = [
  "browser-testing", "document-conversion", "playwright", "markitdown", "codescape",
  ...LOOM_FIRST_PARTY_SERVER_IDS,
] as const;

function isNonBlankStr(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

/** Card fafae623: a strict POSIX-style env-variable-name shape — every `passEnv` entry must match this,
 *  on top of {@link PASS_ENV_RESERVED_DENYLIST} below. Rejects anything that isn't a plain identifier
 *  (no spaces, no `=`, no shell metacharacters) — there is no legitimate env var name this excludes. */
export const ENV_KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Card fafae623: a `passEnv` entry matching any of these (case-insensitive) is rejected, ON TOP of the
 *  charset check above — an owner widening a capability's ambient-env allowlist must never be able to
 *  name Loom's own per-session credential or claude's own control vars, which a strict-shape regex alone
 *  would still allow. `LOOM_MCP_TOKEN` is also covered by the `LOOM_` prefix rule, kept as its own
 *  explicit check so the rule reads directly rather than only by implication. */
const PASS_ENV_RESERVED_PREFIXES = ["CLAUDE_CODE_", "LOOM_"];
const PASS_ENV_RESERVED_EXACT = ["LOOM_MCP_TOKEN"];
export function passEnvReservedReason(name: string): string | null {
  const upper = name.toUpperCase();
  if (PASS_ENV_RESERVED_EXACT.includes(upper)) return `'${name}' is a reserved Loom credential name`;
  for (const prefix of PASS_ENV_RESERVED_PREFIXES) {
    if (upper.startsWith(prefix)) return `'${name}' matches the reserved '${prefix}*' prefix`;
  }
  return null;
}
const PASS_ENV_MAX_KEYS = 32;
/** Card fafae623: validate a `passEnv` array for either create or the PATCH-only update path. Shared so
 *  the two call sites can never drift on what counts as a legal entry. */
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

export interface ValidatedCapabilityDefInput {
  slug: string; name: string; description: string; transport: "stdio" | "http"; kind: CapabilityProvisionKind;
  provision: CapabilityProvision; toolAllowlist: string[]; wantsScratchDir: boolean; requiresConnection: boolean;
  secretEnvVar: string | null; passEnv: string[];
}

/** Validate an owner-added capability's create input. Non-throwing (mirrors validateConnectionInput). */
export function validateCapabilityDefInput(input: {
  slug?: unknown; name?: unknown; description?: unknown; transport?: unknown; kind?: unknown;
  provision?: unknown; toolAllowlist?: unknown; wantsScratchDir?: unknown; requiresConnection?: unknown; secretEnvVar?: unknown;
  passEnv?: unknown;
}): { ok: true; value: ValidatedCapabilityDefInput } | { ok: false; error: string } {
  if (typeof input.slug !== "string" || !SLUG_RE.test(input.slug)) {
    return { ok: false, error: "slug must be lowercase kebab-case (a-z0-9-, starting with a letter/digit)" };
  }
  if ((RESERVED_CAPABILITY_SLUGS as readonly string[]).includes(input.slug)) {
    return { ok: false, error: `slug '${input.slug}' is reserved for a builtin capability` };
  }
  if (!isNonBlankStr(input.name, NAME_MAX)) return { ok: false, error: `name must be a non-empty string of at most ${NAME_MAX} characters` };
  if (typeof input.description !== "string" || input.description.length > DESCRIPTION_MAX) {
    return { ok: false, error: `description must be a string of at most ${DESCRIPTION_MAX} characters` };
  }
  // v1 rejects "http": all three v1 provision kinds are subprocess recipes, and resolveCapabilityServer
  // hardcodes `type: "stdio"` on the mounted entry regardless — an "http" row would silently be inert
  // (validated/stored but never actually usable), so reject it at creation time instead of the confusion.
  if (input.transport !== "stdio") return { ok: false, error: "transport must be 'stdio' (the 'http' transport is not yet supported — all v1 provision kinds are subprocess recipes)" };
  if (input.kind !== "node-package" && input.kind !== "python-venv" && input.kind !== "bundled" && input.kind !== "command") {
    return { ok: false, error: "kind must be 'node-package', 'python-venv', 'bundled', or 'command'" };
  }
  const p = (input.provision ?? {}) as Record<string, unknown>;
  let provision: CapabilityProvision;
  if (input.kind === "node-package") {
    if (!isNonBlankStr(p.package, NAME_MAX) || !isNonBlankStr(p.binRelativeToPackageJson, 300)) {
      return { ok: false, error: "node-package provision requires 'package' and 'binRelativeToPackageJson' strings" };
    }
    provision = { kind: "node-package", package: p.package, binRelativeToPackageJson: p.binRelativeToPackageJson };
  } else if (input.kind === "python-venv") {
    const packages = p.packages;
    if (!Array.isArray(packages) || packages.length === 0 || !packages.every((x) => isNonBlankStr(x, NAME_MAX))) {
      return { ok: false, error: "python-venv provision requires a non-empty 'packages' string array" };
    }
    if (!isNonBlankStr(p.binary, NAME_MAX)) return { ok: false, error: "python-venv provision requires a 'binary' string" };
    provision = { kind: "python-venv", packages, binary: p.binary, probeImport: typeof p.probeImport === "string" ? p.probeImport : undefined };
  } else if (input.kind === "bundled") {
    if (!isNonBlankStr(p.command, 500)) return { ok: false, error: "bundled provision requires a 'command' string" };
    const args = p.args;
    if (args !== undefined && (!Array.isArray(args) || !args.every((x) => typeof x === "string"))) {
      return { ok: false, error: "bundled provision's 'args' must be a string array when present" };
    }
    const outputDirEnvVar = p.outputDirEnvVar;
    if (outputDirEnvVar !== undefined && !isNonBlankStr(outputDirEnvVar, NAME_MAX)) {
      return { ok: false, error: "bundled provision's 'outputDirEnvVar' must be a non-empty string when present" };
    }
    provision = { kind: "bundled", command: p.command, args: args as string[] | undefined, outputDirEnvVar: outputDirEnvVar as string | undefined };
  } else {
    // command: an owner-typed arbitrary executable — OWNER-APPROVED as owner-typed-therefore-trusted
    // (same trust model as gateCommand). Resolved to an ABSOLUTE path here, at catalog-SAVE time, so an
    // unresolvable command fails the save explicitly instead of silently no-op-ing at every spawn.
    if (!isNonBlankStr(p.command, 500)) return { ok: false, error: "command provision requires a 'command' string" };
    const args = p.args;
    if (args !== undefined && (!Array.isArray(args) || !args.every((x) => typeof x === "string"))) {
      return { ok: false, error: "command provision's 'args' must be a string array when present" };
    }
    // resolveExecutable only fs-verifies a BARE name via a PATH search; an already-absolute or
    // slash-containing path is returned as-is with NO existence check. Without the fs.existsSync below, a
    // nonexistent absolute/relative path (e.g. "/usr/bin/fooo", "C:\bad\x.exe") would pass this guard and
    // then silently no-op at every future spawn — exactly the outcome this save-time check exists to
    // prevent. Both branches of "unresolvable" (bare name not on PATH, or a path that doesn't exist) must
    // fail the save.
    const resolved = resolveExecutable(p.command);
    if (!path.isAbsolute(resolved) || !fs.existsSync(resolved)) {
      return { ok: false, error: `command '${p.command}' could not be resolved to an executable (not absolute/not found on PATH, or does not exist)` };
    }
    const outputDirEnvVar = p.outputDirEnvVar;
    if (outputDirEnvVar !== undefined && !isNonBlankStr(outputDirEnvVar, NAME_MAX)) {
      return { ok: false, error: "command provision's 'outputDirEnvVar' must be a non-empty string when present" };
    }
    provision = { kind: "command", command: resolved, args: args as string[] | undefined, outputDirEnvVar: outputDirEnvVar as string | undefined };
  }
  const toolAllowlist = input.toolAllowlist;
  if (!Array.isArray(toolAllowlist) || !toolAllowlist.every((x) => typeof x === "string")) {
    return { ok: false, error: "toolAllowlist must be a string array" };
  }
  const requiresConnection = !!input.requiresConnection;
  if (requiresConnection && !isNonBlankStr(input.secretEnvVar, NAME_MAX)) {
    return { ok: false, error: "secretEnvVar is required (the env var name the credential is injected under) when requiresConnection is true" };
  }
  // outputDirEnvVar and secretEnvVar are two DIFFERENT values injected into the SAME mounted server's `env`
  // object (resolveCapabilityServer) — an equal name would have one silently clobber the other at spawn
  // time (whichever assignment runs last wins), so reject the self-harm at save time instead.
  const provisionOutputDirEnvVar = (provision as { outputDirEnvVar?: string }).outputDirEnvVar;
  if (requiresConnection && provisionOutputDirEnvVar && provisionOutputDirEnvVar === input.secretEnvVar) {
    return { ok: false, error: "outputDirEnvVar must not equal secretEnvVar (they would collide in the mounted server's env block)" };
  }
  const passEnvResult = validatePassEnv(input.passEnv);
  if (!passEnvResult.ok) return passEnvResult;
  return {
    ok: true,
    value: {
      slug: input.slug, name: input.name.trim(), description: input.description,
      transport: input.transport, kind: input.kind, provision, toolAllowlist,
      wantsScratchDir: !!input.wantsScratchDir, requiresConnection,
      secretEnvVar: requiresConnection ? (input.secretEnvVar as string) : null,
      passEnv: passEnvResult.value,
    },
  };
}

function toSummary(row: CapabilityDefRow): CapabilitySummary {
  return { id: row.id, slug: row.slug, name: row.name, description: row.description, transport: row.transport, kind: row.kind, requiresConnection: row.requiresConnection, builtin: false, passEnv: row.passEnv };
}

/**
 * The BUILTIN capabilities' REST-facing summaries — hardcoded (not catalog rows; see the module doc)
 * so the Settings UI's catalog panel and the Profile editor's picker can list them alongside owner-added
 * ones in ONE unified view, without a client-side special case for "the first two are different."
 */
export const BUILTIN_CAPABILITY_SUMMARIES: CapabilitySummary[] = [
  {
    slug: "browser-testing", name: "Browser testing",
    description: "Inject a per-session Playwright MCP so a rig can drive its own isolated headless browser (navigate / click / fill / assert).",
    transport: "stdio", kind: "node-package", requiresConnection: false, builtin: true,
  },
  {
    slug: "document-conversion", name: "Document conversion",
    description: "Inject a per-session markitdown MCP so a rig can convert files (PDF / Office / images / HTML) to Markdown to save tokens.",
    transport: "stdio", kind: "python-venv", requiresConnection: false, builtin: true,
  },
];

/** List every capability — the builtins FIRST, then every owner-added row — as REST-facing summaries. */
export function listCapabilitySummaries(db: CapabilitiesDbStore): CapabilitySummary[] {
  return [...BUILTIN_CAPABILITY_SUMMARIES, ...db.listCapabilityDefs().map(toSummary)];
}

/** Create an owner-added capability def. Throws a descriptive Error on invalid/duplicate input. */
export function createCapabilityDef(db: CapabilitiesDbStore, input: Parameters<typeof validateCapabilityDefInput>[0]): CapabilitySummary {
  const v = validateCapabilityDefInput(input);
  if (!v.ok) throw new Error(v.error);
  if (db.getCapabilityDefBySlug(v.value.slug)) throw new Error(`a capability with slug '${v.value.slug}' already exists`);
  const row = db.createCapabilityDef({
    slug: v.value.slug, name: v.value.name, description: v.value.description, transport: v.value.transport,
    kind: v.value.kind, provisionJson: JSON.stringify(v.value.provision), toolAllowlistJson: JSON.stringify(v.value.toolAllowlist),
    wantsScratchDir: v.value.wantsScratchDir, requiresConnection: v.value.requiresConnection, secretEnvVar: v.value.secretEnvVar,
    passEnv: v.value.passEnv,
  });
  return toSummary(row);
}

/** Delete (revoke) an owner-added capability def by id — idempotent, mirrors deleteConnection. */
export function deleteCapabilityDef(db: CapabilitiesDbStore, id: string): void {
  db.deleteCapabilityDef(id);
  // ACCEPTED for v1 (code review): this does NOT clear the slug-keyed `resolvedBinCache`/`provisionStatus`
  // below. Low-risk edge — a python-venv capability deleted and then RE-CREATED under the exact same slug
  // would reuse its stale cached resolution/status rather than re-provisioning. Revisit if slug reuse
  // after delete becomes a real workflow; today deletion is expected to be rare and slugs aren't recycled.
}

/**
 * Card fafae623: update ONLY an existing capability def's `passEnv` — the ONE field an owner may widen
 * after creation (every other field is create-time-only; there is still no general "edit" route). Throws
 * a descriptive Error on invalid input or an unknown id (mirrors createCapabilityDef's own throw style).
 */
export function updateCapabilityDefPassEnv(db: CapabilitiesDbStore, id: string, passEnv: unknown): CapabilitySummary {
  const v = validatePassEnv(passEnv);
  if (!v.ok) throw new Error(v.error);
  const row = db.updateCapabilityDefPassEnv(id, v.value);
  if (!row) throw new Error(`no capability def with id '${id}'`);
  return toSummary(row);
}

/**
 * Code Review round 1 (reviewer b5883c03), item 4: `PATCH /api/capabilities/:id`'s body MUST name the
 * `passEnv` key explicitly — `{}` or a typo'd key name must be REJECTED, never silently treated as
 * "clear it to []". Pure so the REST handler's requirement is directly unit-testable without a real
 * HTTP server; `updateCapabilityDefPassEnv` itself stays agnostic to "was the key present at all" (it
 * only ever sees the resolved value), so this check lives here, one level up, not inside it.
 */
export function requirePassEnvKey(body: Record<string, unknown>): string | null {
  return "passEnv" in body ? null : "passEnv is required (pass [] explicitly to clear it)";
}

// --- generic resolution (owner-added rows only; the two builtins keep their own bespoke code in host.ts) ---

export interface ResolveCapabilityCtx {
  scratchDir?: string;
  /** The bound P1 connection's DECRYPTED secret (already resolved by the caller), or undefined when this
   *  capability doesn't requireConnection or no connectionId was bound on the grant. */
  connectionSecret?: string;
  pythonInterpreterPath?: string;
}
export type CapabilityMcpServer = { type: "stdio"; command: string; args: string[]; env?: Record<string, string> };

/** Per-slug provisioning state (mirrors host.ts's markitdown globals, generalized to N independent slugs
 *  AND to more than one provisioning kind — python-venv and github-binary share this ONE tracker, keyed
 *  by slug, since slugs are unique across the whole catalog). */
export type CapabilityProvisionState = "idle" | "installing" | "ready" | "failed";
export interface CapabilityProvisionStatus { state: CapabilityProvisionState; reason?: ProvisionOutcome | GithubBinaryProvisionOutcome | NpmPinnedProvisionOutcome; errorTail?: string; binary?: string; lastAttemptAt?: number }
const provisionStatus = new Map<string, CapabilityProvisionStatus>();
const provisionInFlight = new Map<string, Promise<void>>();
const resolvedBinCache = new Map<string, string>();
type CapabilityProvisioner = (opts: EnsurePythonPackageOpts) => Promise<EnsurePythonResult>;
let provisioner: CapabilityProvisioner = ensurePythonPackageAsync;
type GithubBinaryProvisioner = (opts: EnsureGithubBinaryOpts) => Promise<EnsureGithubBinaryResult>;
let githubBinaryProvisioner: GithubBinaryProvisioner = ensureGithubMcpBinaryAsync;
type NpmPinnedProvisioner = (opts: EnsureNpmPinnedOpts) => Promise<EnsureNpmPinnedResult>;
let npmPinnedProvisioner: NpmPinnedProvisioner = ensureNpmPinnedAsync;

/** Current per-slug provisioning status (a copy), or undefined if never attempted for this slug. */
export function getCapabilityProvisionStatus(slug: string): CapabilityProvisionStatus | undefined {
  const s = provisionStatus.get(slug);
  return s ? { ...s } : undefined;
}

/** TEST-ONLY: swap the python-venv provisioner + reset ALL per-slug state (mirrors __setMarkitdownProvisionerForTest). */
export function __setCapabilityProvisionerForTest(fn?: CapabilityProvisioner): void {
  provisioner = fn ?? ensurePythonPackageAsync;
  provisionStatus.clear();
  provisionInFlight.clear();
  resolvedBinCache.clear();
}

/** TEST-ONLY: swap the github-binary provisioner + reset ALL per-slug state (same shared tracker as above). */
export function __setGithubBinaryProvisionerForTest(fn?: GithubBinaryProvisioner): void {
  githubBinaryProvisioner = fn ?? ensureGithubMcpBinaryAsync;
  provisionStatus.clear();
  provisionInFlight.clear();
  resolvedBinCache.clear();
}

/** TEST-ONLY: swap the npm-pinned provisioner + reset ALL per-slug state (same shared tracker as above). */
export function __setNpmPinnedProvisionerForTest(fn?: NpmPinnedProvisioner): void {
  npmPinnedProvisioner = fn ?? ensureNpmPinnedAsync;
  provisionStatus.clear();
  provisionInFlight.clear();
  resolvedBinCache.clear();
}

// Mirrors MARKITDOWN_PIP_TIMEOUT_MS (host.ts) — a heavy first pip install needs headroom, still bounded.
const CAPABILITY_PIP_TIMEOUT_MS = 900_000;

/** Cooldown after a TERMINAL `failed` outcome before a fresh npm-pinned install fires for the same slug —
 *  stops an offline host from paying a full-timeout attempt on every spawn. Scoped to
 *  {@link resolveNpmPinned} only (python-venv/github-binary's own tests issue consecutive same-slug
 *  failures a shared cooldown would suppress) — see docs/decisions/e7d6e43b-npm-pinned-shell-true-and-pin-scope.md.
 *  {@link resetCapabilityProvisionStatus} is the explicit human-retry bypass. */
const NPM_PINNED_RETRY_COOLDOWN_MS = 60_000;

/** One provisioning job's result — the shape every kind-specific provisioner (python-venv, github-binary,
 *  future kinds) normalizes to before handing it to the ONE shared kick/status machinery below. */
interface CapabilityProvisionJobResult { binary: string | null; outcome: ProvisionOutcome | GithubBinaryProvisionOutcome | NpmPinnedProvisionOutcome; errorTail?: string }

/**
 * The explicit, human-initiated bypass for {@link NPM_PINNED_RETRY_COOLDOWN_MS} — called by the
 * provisioning-status REST retry routes right before re-resolving, never by any automatic/spawn-triggered
 * path. Code Review round 2 finding: this must clear ONLY a TERMINAL `failed` status, never `ready`/
 * `installing` — clearing unconditionally made a retry on an already-ready (or still-installing) slug
 * report `idle` until the next resolve re-populates it (and, for `ready`, the per-slug cache short-circuit
 * below never even reaches the code that would re-populate it — see those resolvers' own fix for why they
 * now re-assert `ready` on every cache hit regardless).
 */
export function resetCapabilityProvisionStatus(slug: string): void {
  if (provisionStatus.get(slug)?.state === "failed") provisionStatus.delete(slug);
}

/** Kick a per-slug BACKGROUND provisioning job — kind-agnostic (the caller's `run` closure does the actual
 *  kind-specific work: pip install, or download+verify+extract). Dedupes ONLY a genuinely in-flight job
 *  (retryable after a terminal outcome); never downgrades an already-`ready` status (a concurrent resolve
 *  may have proven the binary present first). */
function kickCapabilityProvision(slug: string, run: () => Promise<CapabilityProvisionJobResult>): void {
  if (provisionInFlight.get(slug)) return; // dedupe ONLY a genuinely in-flight install (retryable after terminal)
  const attemptAt = Date.now();
  provisionStatus.set(slug, { state: "installing", lastAttemptAt: attemptAt });
  const job = run()
    .then((res) => {
      if (res.outcome === "ready" && res.binary) {
        resolvedBinCache.set(slug, res.binary);
        provisionStatus.set(slug, { state: "ready", binary: res.binary, lastAttemptAt: attemptAt });
      } else if (provisionStatus.get(slug)?.state !== "ready") {
        // never downgrade an already-ready status (a concurrent resolve may have proven the binary present)
        provisionStatus.set(slug, { state: "failed", reason: res.outcome, errorTail: res.errorTail, lastAttemptAt: attemptAt });
      }
    })
    .catch(() => {
      if (provisionStatus.get(slug)?.state !== "ready") provisionStatus.set(slug, { state: "failed", lastAttemptAt: attemptAt });
    })
    .finally(() => { provisionInFlight.delete(slug); });
  provisionInFlight.set(slug, job);
}

function resolveNodePackage(provision: Extract<CapabilityProvision, { kind: "node-package" }>): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve(`${provision.package}/package.json`);
    return path.join(path.dirname(pkgJson), provision.binRelativeToPackageJson);
  } catch {
    return null;
  }
}

function resolvePythonVenv(slug: string, provision: Extract<CapabilityProvision, { kind: "python-venv" }>, pythonInterpreterPath?: string): string | null {
  const cached = resolvedBinCache.get(slug);
  if (cached) {
    // Re-assert on every cache hit (Code Review round 2) — a retry/reset elsewhere must never leave a
    // cached-resolved slug reporting anything other than 'ready'.
    provisionStatus.set(slug, { state: "ready", binary: cached, lastAttemptAt: Date.now() });
    return cached;
  }
  const bin = loomVenvBin(provision.binary);
  if (fs.existsSync(bin)) {
    resolvedBinCache.set(slug, bin);
    provisionStatus.set(slug, { state: "ready", binary: bin, lastAttemptAt: Date.now() });
    return bin;
  }
  // cold → provision in the BACKGROUND; skip this spawn
  kickCapabilityProvision(slug, () => provisioner({
    package: provision.packages, binary: provision.binary, probeImport: provision.probeImport,
    timeoutMs: CAPABILITY_PIP_TIMEOUT_MS, interpreterOverride: pythonInterpreterPath,
  }));
  return null;
}

/**
 * Resolve the github-mcp-server binary for one capability_defs row — mirrors {@link resolvePythonVenv}'s
 * shape exactly: a per-slug cache short-circuit, then a fast `fs.existsSync` on the resolved absolute path,
 * and a background kick on a cold miss (never blocks the spawn hot path). `LOOM_GITHUB_MCP_BIN` is a
 * HUMAN-only override (mirrors `LOOM_MARKITDOWN_BIN`) — an already-installed binary, and the fast TEST seam
 * so CI never downloads a real release asset.
 */
function resolveGithubBinary(slug: string, provision: Extract<CapabilityProvision, { kind: "github-binary" }>): string | null {
  const cached = resolvedBinCache.get(slug);
  if (cached) {
    // Re-assert on every cache hit (Code Review round 2) — a retry/reset elsewhere must never leave a
    // cached-resolved slug reporting anything other than 'ready'.
    provisionStatus.set(slug, { state: "ready", binary: cached, lastAttemptAt: Date.now() });
    return cached;
  }
  const override = process.env.LOOM_GITHUB_MCP_BIN;
  if (override) {
    const resolved = resolveExecutable(override);
    if (path.isAbsolute(resolved) && fs.existsSync(resolved)) {
      resolvedBinCache.set(slug, resolved);
      provisionStatus.set(slug, { state: "ready", binary: resolved, lastAttemptAt: Date.now() });
      return resolved;
    }
    return null; // human pointed the override somewhere unresolvable — respect it, don't auto-provision
  }
  const bin = loomGithubMcpBin(provision.version);
  if (fs.existsSync(bin)) {
    resolvedBinCache.set(slug, bin);
    provisionStatus.set(slug, { state: "ready", binary: bin, lastAttemptAt: Date.now() });
    return bin;
  }
  // cold → download+verify+extract in the BACKGROUND; skip this spawn
  kickCapabilityProvision(slug, () => githubBinaryProvisioner({ version: provision.version }));
  return null;
}

/**
 * Resolve a pinned npm package's bin for one capability_defs row — mirrors {@link resolveGithubBinary}'s
 * shape exactly: a per-slug cache short-circuit, then a fast `fs.existsSync` on the resolved absolute
 * path, and a background kick on a cold miss (never blocks the spawn hot path). No human-only override
 * seam like `LOOM_GITHUB_MCP_BIN`/`LOOM_MARKITDOWN_BIN` exists for this kind today — add one if a real
 * need for pointing an npm-pinned capability at an already-installed binary shows up.
 */
function resolveNpmPinned(slug: string, provision: Extract<CapabilityProvision, { kind: "npm-pinned" }>): string | null {
  const cached = resolvedBinCache.get(slug);
  if (cached) {
    // Re-assert on every cache hit (Code Review round 2) — a retry/reset elsewhere must never leave a
    // cached-resolved slug reporting anything other than 'ready'.
    provisionStatus.set(slug, { state: "ready", binary: cached, lastAttemptAt: Date.now() });
    return cached;
  }
  // ORDER IS LOAD-BEARING (Code Review finding — see the e7d6e43b decision record cited in
  // npm-pinned.ts's module doc): validate BEFORE building/checking any path. A corrupted row's
  // binRelativeToPackageJson (e.g. "../../x.js") would otherwise let loomNpmPinnedBin's path.join
  // traverse OUTSIDE the intended install dir, and the fs.existsSync below would see a real, unrelated,
  // already-existing file as "ready" — a validator bypass, since validateNpmPinnedSpec was previously
  // only ever called from the cold/background path (ensureNpmPinnedAsync), never here on the hot path.
  const invalid = validateNpmPinnedSpec(provision.package, provision.version, provision.binRelativeToPackageJson);
  if (invalid) {
    provisionStatus.set(slug, { state: "failed", reason: "invalid-spec", errorTail: invalid, lastAttemptAt: Date.now() });
    return null;
  }
  const bin = loomNpmPinnedBin(provision.package, provision.version, provision.binRelativeToPackageJson);
  if (fs.existsSync(bin)) {
    resolvedBinCache.set(slug, bin);
    provisionStatus.set(slug, { state: "ready", binary: bin, lastAttemptAt: Date.now() });
    return bin;
  }
  // Backoff (Code Review Minor, see NPM_PINNED_RETRY_COOLDOWN_MS's own doc): don't fire a brand-new,
  // full-timeout install attempt on every single spawn while the last one is still within its cooldown
  // window — an explicit human retry bypasses this via resetCapabilityProvisionStatus.
  const existing = provisionStatus.get(slug);
  if (existing?.state === "failed" && existing.lastAttemptAt != null && Date.now() - existing.lastAttemptAt < NPM_PINNED_RETRY_COOLDOWN_MS) {
    return null;
  }
  // cold → install in the BACKGROUND; skip this spawn
  kickCapabilityProvision(slug, () => npmPinnedProvisioner({
    package: provision.package, version: provision.version, binRelativeToPackageJson: provision.binRelativeToPackageJson,
  }));
  return null;
}

/**
 * Resolve one owner-added capability's stdio MCP entry, or null when unresolvable THIS spawn (the caller
 * logs + skips — never throws). `node-package`/`bundled` resolve synchronously (fast fs/require checks,
 * no blocking work); `python-venv` reuses the fs.existsSync fast-check + background-kick pattern, keyed
 * PER-SLUG so N owner-added python-venv capabilities provision independently. A `requiresConnection`
 * capability with a resolved `ctx.connectionSecret` gets it injected into the returned server's `env`
 * block under `row.secretEnvVar` — never into `args` (argv is visible in process listings) and never
 * returned to the caller in any other shape.
 *
 * NEVER THROWS: a malformed/corrupt `provisionJson` (a hand-edited DB row, a future schema change) must
 * degrade to "this one capability is unresolvable" (null, caller logs + skips) — not crash the ENTIRE
 * spawn loop (buildMcpServers iterates every OTHER enabled capability too, all of which must still mount).
 */
export function resolveCapabilityServer(row: CapabilityDefRow, ctx: ResolveCapabilityCtx): CapabilityMcpServer | null {
  let provision: CapabilityProvision;
  try {
    provision = JSON.parse(row.provisionJson) as CapabilityProvision;
  } catch {
    return null;
  }
  let server: { command: string; args: string[] } | null = null;
  if (provision.kind === "node-package") {
    const bin = resolveNodePackage(provision);
    if (bin) {
      const args = [bin];
      // ACCEPTED for v1 (code review, agent-tooling P4): `--output-dir` is Playwright's OWN flag name,
      // hardcoded here rather than a per-capability configurable flag. wantsScratchDir is owner opt-in —
      // an owner-added node-package capability whose CLI doesn't understand `--output-dir` simply gets an
      // unrecognized flag (the owner controls both the capability def and its flag conventions). Revisit
      // if a second node-package capability ships with a different output-flag convention.
      if (row.wantsScratchDir && ctx.scratchDir) args.push("--output-dir", ctx.scratchDir);
      server = { command: process.execPath, args };
    }
  } else if (provision.kind === "python-venv") {
    const bin = resolvePythonVenv(row.slug, provision, ctx.pythonInterpreterPath);
    if (bin) server = { command: bin, args: [] };
  } else if (provision.kind === "bundled" || provision.kind === "command") {
    // bundled: a Loom-curated recipe — `command` may be an ALREADY-ABSOLUTE path, or a BARE PATH-searched
    // name (e.g. "npx", the github capability seed) that must self-heal like the hardcoded builtins
    // (Playwright/markitdown) already do, each re-resolving live at every spawn. CODE-REVIEW FIX: a
    // bare command must NOT be resolved once and frozen (a stripped-PATH boot would never mount it again
    // even after the real binary becomes installed; a moved fnm/nvm/volta shim would 404 silently forever;
    // a DB restored on another machine would carry a dead path) — so re-run `resolveExecutable` EVERY
    // spawn, not just once at catalog-save time. command (owner-typed, "command" kind): already resolved to
    // an absolute path at catalog-save time (validateCapabilityDefInput) — `resolveExecutable` on an
    // already-absolute path is a no-op passthrough (see resolve-bin.ts), so this is BEHAVIOR-PRESERVING for
    // every existing "command" row. NO SHELL: this {command, args} entry is mounted as a "stdio" MCP
    // server, launched by the CLAUDE ENGINE's own MCP stdio client as an argv-array subprocess — never
    // through node-pty and never through `/bin/sh -c` — so there is no metachar-injection surface even
    // though `command`'s two strings are owner-controlled end to end (the containment posture here is
    // who-can-set, not sandboxing what's set).
    const resolvedCommand = resolveExecutable(provision.command);
    if (fs.existsSync(resolvedCommand)) server = { command: resolvedCommand, args: provision.args ?? [] };
  } else if (provision.kind === "github-binary") {
    const bin = resolveGithubBinary(row.slug, provision);
    if (bin) server = { command: bin, args: ["stdio"] };
  } else if (provision.kind === "npm-pinned") {
    // Mounted like node-package (node + an absolute bin script) — but WITHOUT that branch's hardcoded
    // `--output-dir` CLI flag (Playwright's own convention, not generic); an npm-pinned row's scratch dir
    // (if any) rides the shared outputDirEnvVar env-injection below instead, same as bundled/command.
    const bin = resolveNpmPinned(row.slug, provision);
    if (bin) server = { command: process.execPath, args: [bin] };
  }
  if (!server) return null;
  const env: Record<string, string> = {};
  if (row.requiresConnection && ctx.connectionSecret) {
    // @decision 2be634f2 — never move this onto claude's OWN process env (a win32 ${VAR}-placeholder
    // pattern, mirroring a50b8afd's mcpToken case) — that env is inherited by the agent's own shell.
    env[row.secretEnvVar ?? "LOOM_CAPABILITY_SECRET"] = ctx.connectionSecret;
  }
  // The bundled/command env-var-based scratch-dir mechanism (see CapabilityProvision's `outputDirEnvVar`
  // doc): a CLI that takes its output directory via its OWN env var rather than a flag (unlike the
  // node-package branch's hardcoded `--output-dir` arg above). Additive: only fires when a row's provision
  // explicitly sets it, so every existing bundled/command row (none of which set it today) is unaffected.
  if ((provision.kind === "bundled" || provision.kind === "command" || provision.kind === "npm-pinned") && provision.outputDirEnvVar && row.wantsScratchDir && ctx.scratchDir) {
    env[provision.outputDirEnvVar] = ctx.scratchDir;
  }
  const hasEnv = Object.keys(env).length > 0;
  // Card fafae623, Code Review round 1 item 3: env-isolation wrapping moved OUT of this producer and
  // into buildMcpServers' ONE chokepoint loop (so a FUTURE provision kind added here can't forget it
  // the way this function once could) — this returns the raw, unwrapped mount. buildMcpServers reads
  // `row.passEnv` itself (from the SAME catalog row its own caller already looked up) to compute that
  // mount's `--allow` list; this function no longer needs to know about passEnv at all.
  return { type: "stdio", ...server, ...(hasEnv ? { env } : {}) };
}
