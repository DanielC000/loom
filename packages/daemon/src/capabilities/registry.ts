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
 * The three BUILTIN capabilities (browser-testing/document-conversion/deja-corpus) are NOT rows in this
 * table — they stay special-cased in `buildMcpServers` (pty/host.ts), reusing their existing,
 * already-hardened resolution code (`playwrightMcpServer`/`markitdownMcpServer`/`dejaMcpServer`)
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
import { resolveExecutable } from "../pty/resolve-bin.js";
import { isLoomDev } from "../paths.js";

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
  createdAt: string;
}

/** The narrow db surface this module needs (mirrors ConnectionsDbStore's shape in connections/store.ts). */
export interface CapabilitiesDbStore {
  listCapabilityDefs(): CapabilityDefRow[];
  getCapabilityDefBySlug(slug: string): CapabilityDefRow | undefined;
  createCapabilityDef(input: Omit<CapabilityDefRow, "id" | "createdAt">): CapabilityDefRow;
  deleteCapabilityDef(id: string): void;
}

export type CapabilityProvision =
  | { kind: "node-package"; package: string; binRelativeToPackageJson: string }
  | { kind: "python-venv"; packages: string[]; binary: string; probeImport?: string }
  | { kind: "bundled"; command: string; args?: string[] }
  | { kind: "command"; command: string; args?: string[] }
  | { kind: "github-binary"; version: string };

const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The three legacy-bridged slugs (@loom/shared's `LEGACY_CAPABILITY_SLUGS`) — reserved so an owner-added
 *  row can never collide with or shadow a builtin. Duplicated as string literals (not imported) to keep
 *  this module's validation independent of the shared bridge helper's own location. */
export const RESERVED_CAPABILITY_SLUGS = ["browser-testing", "document-conversion", "deja-corpus"] as const;

function isNonBlankStr(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

export interface ValidatedCapabilityDefInput {
  slug: string; name: string; description: string; transport: "stdio" | "http"; kind: CapabilityProvisionKind;
  provision: CapabilityProvision; toolAllowlist: string[]; wantsScratchDir: boolean; requiresConnection: boolean;
  secretEnvVar: string | null;
}

/** Validate an owner-added capability's create input. Non-throwing (mirrors validateConnectionInput). */
export function validateCapabilityDefInput(input: {
  slug?: unknown; name?: unknown; description?: unknown; transport?: unknown; kind?: unknown;
  provision?: unknown; toolAllowlist?: unknown; wantsScratchDir?: unknown; requiresConnection?: unknown; secretEnvVar?: unknown;
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
    provision = { kind: "bundled", command: p.command, args: args as string[] | undefined };
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
    provision = { kind: "command", command: resolved, args: args as string[] | undefined };
  }
  const toolAllowlist = input.toolAllowlist;
  if (!Array.isArray(toolAllowlist) || !toolAllowlist.every((x) => typeof x === "string")) {
    return { ok: false, error: "toolAllowlist must be a string array" };
  }
  const requiresConnection = !!input.requiresConnection;
  if (requiresConnection && !isNonBlankStr(input.secretEnvVar, NAME_MAX)) {
    return { ok: false, error: "secretEnvVar is required (the env var name the credential is injected under) when requiresConnection is true" };
  }
  return {
    ok: true,
    value: {
      slug: input.slug, name: input.name.trim(), description: input.description,
      transport: input.transport, kind: input.kind, provision, toolAllowlist,
      wantsScratchDir: !!input.wantsScratchDir, requiresConnection,
      secretEnvVar: requiresConnection ? (input.secretEnvVar as string) : null,
    },
  };
}

function toSummary(row: CapabilityDefRow): CapabilitySummary {
  return { id: row.id, slug: row.slug, name: row.name, description: row.description, transport: row.transport, kind: row.kind, requiresConnection: row.requiresConnection, builtin: false };
}

/**
 * The two BUILTIN capabilities' REST-facing summaries — hardcoded (not catalog rows; see the module doc)
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
  {
    slug: "deja-corpus", name: "Deja mockup corpus",
    description: "Inject a per-session Deja MCP so a mockup-generating rig can retrieve prior mockups (find_mockups) and submit the one it just wrote (submit_mockup/mark_reused).",
    transport: "stdio", kind: "bundled", requiresConnection: false, builtin: true,
  },
];

/**
 * List every capability — the builtins FIRST, then every owner-added row — as REST-facing summaries.
 * "deja-corpus" is dropped on a non-`LOOM_DEV` build: Deja is a PRIVATE product (Loom is public on npm),
 * so a regular `loomctl` user's GET /api/capabilities must never even NAME it, independent of the two
 * UI-level toggle hides in Profiles.tsx/Settings.tsx (same isLoomDev() gate as the Platform layer).
 */
export function listCapabilitySummaries(db: CapabilitiesDbStore): CapabilitySummary[] {
  const builtins = isLoomDev() ? BUILTIN_CAPABILITY_SUMMARIES : BUILTIN_CAPABILITY_SUMMARIES.filter((c) => c.slug !== "deja-corpus");
  return [...builtins, ...db.listCapabilityDefs().map(toSummary)];
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
export interface CapabilityProvisionStatus { state: CapabilityProvisionState; reason?: ProvisionOutcome | GithubBinaryProvisionOutcome; errorTail?: string; binary?: string; lastAttemptAt?: number }
const provisionStatus = new Map<string, CapabilityProvisionStatus>();
const provisionInFlight = new Map<string, Promise<void>>();
const resolvedBinCache = new Map<string, string>();
type CapabilityProvisioner = (opts: EnsurePythonPackageOpts) => Promise<EnsurePythonResult>;
let provisioner: CapabilityProvisioner = ensurePythonPackageAsync;
type GithubBinaryProvisioner = (opts: EnsureGithubBinaryOpts) => Promise<EnsureGithubBinaryResult>;
let githubBinaryProvisioner: GithubBinaryProvisioner = ensureGithubMcpBinaryAsync;

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

// Mirrors MARKITDOWN_PIP_TIMEOUT_MS (host.ts) — a heavy first pip install needs headroom, still bounded.
const CAPABILITY_PIP_TIMEOUT_MS = 900_000;

/** One provisioning job's result — the shape every kind-specific provisioner (python-venv, github-binary,
 *  future kinds) normalizes to before handing it to the ONE shared kick/status machinery below. */
interface CapabilityProvisionJobResult { binary: string | null; outcome: ProvisionOutcome | GithubBinaryProvisionOutcome; errorTail?: string }

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
  if (cached) return cached;
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
  if (cached) return cached;
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
    // name (e.g. "npx", the github capability seed) that must self-heal like the three hardcoded builtins
    // (Playwright/markitdown/deja) already do, each re-resolving live at every spawn. CODE-REVIEW FIX: a
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
  }
  if (!server) return null;
  const env = row.requiresConnection && ctx.connectionSecret
    ? { [row.secretEnvVar ?? "LOOM_CAPABILITY_SECRET"]: ctx.connectionSecret }
    : undefined;
  return { type: "stdio", ...server, ...(env ? { env } : {}) };
}
