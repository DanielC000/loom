/**
 * Loom's bundled registry-capability catalog rows — the capabilities analog of profiles/seed.ts's
 * BUNDLED_PROFILES. v1 ships exactly one: GitHub, the FIRST real credential-tied capability (agent-tooling
 * P4 follow-on, board card 3b0c4aef) — proving the `requiresConnection`/`{slug, connectionId}` connection-
 * bind path end-to-end (P4 v1 hermetically tested that plumbing with a FAKE capability only; this is the
 * first REAL one). Seeded as an ordinary `capability_defs` ROW — not a fourth hardcoded builtin slug like
 * browser-testing/document-conversion/deja-corpus, which bypass the credential-tie injection entirely (see
 * `buildMcpServers` in `pty/host.ts`) — so binding it exercises the SAME generic node-package/python-venv/
 * bundled/command/github-binary dispatch + spawn-time secret-env-injection an owner-added row gets. Nothing
 * in `pty/host.ts` needed to change: `getCapabilityCatalog`/`resolveConnectionSecret` already read every
 * `capability_defs` row generically.
 *
 * kind "github-binary" (migrated off the archived `@modelcontextprotocol/server-github` npx package):
 * GitHub's maintained `github/github-mcp-server` is provisioned as a Loom-managed, checksum-verified Go
 * binary downloaded to `<LOOM_HOME>/bin/github-mcp-server/<version>/` — see `capabilities/github-binary.ts`
 * for the download+verify+extract pipeline and `registry.ts`'s `resolveGithubBinary` for the
 * fs.existsSync-fast-path + background-provision resolution (mirrors `python-venv`). This is a SEED-ONLY
 * kind (see `CapabilityProvisionKind`'s doc) — `validateCapabilityDefInput` never accepts it from an owner,
 * so this seeded row is the only "github-binary" capability that can ever exist. The bound P1 connection's
 * token lands in `GITHUB_PERSONAL_ACCESS_TOKEN`, the env var the binary reads — server-side, into the MCP
 * subprocess's OWN env only (never a CLI arg, never the claude process — see `resolveCapabilityServer`).
 * `migrateGithubCapabilityToBinary` (below) rewrites an EXISTING install's old `bundled`/npx row to this
 * shape at boot — see its own doc for the narrow-match/idempotency contract.
 */
import type { Db } from "../db.js";
import type { CapabilityDefRow } from "./registry.js";
import { GITHUB_MCP_SERVER_VERSION } from "./github-binary.js";

/** The shipped definition for every bundled capability. */
export function bundledCapabilities(): Omit<CapabilityDefRow, "id" | "createdAt">[] {
  return [
    {
      slug: "github",
      name: "GitHub",
      description:
        "Inject a per-session GitHub MCP so a bound rig can read and act on issues, pull requests, and repo content via the GitHub API. Needs a bound connection holding a GitHub personal access token — that token's OWN scopes are the containment boundary for the granted tool surface (the allowlist grants the whole read+write mcp__github server; the PAT's scopes are the guard).",
      transport: "stdio",
      kind: "github-binary",
      provisionJson: JSON.stringify({
        kind: "github-binary",
        version: GITHUB_MCP_SERVER_VERSION,
      }),
      toolAllowlistJson: JSON.stringify(["mcp__github"]),
      wantsScratchDir: false,
      requiresConnection: true,
      secretEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
    },
  ];
}

/**
 * Seed Loom's bundled registry-capability catalog rows into `capability_defs`, seed-if-absent BY SLUG
 * (mirrors `seedDefaultProfiles`' seed-if-absent-by-name) — idempotent, and matches the standing
 * seed-if-absent contract every other bundled entity here uses (a slug an owner has since deleted is
 * eligible to reappear on a later boot, exactly like a deleted bundled profile/skill would). CORE product,
 * UNGATED — ships to every loomctl user (no `LOOM_DEV` gate), unlike the platform-only seeds.
 */
export function seedDefaultCapabilities(db: Db): string[] {
  const existing = new Set(db.listCapabilityDefs().map((c) => c.slug));
  const seeded: string[] = [];
  for (const c of bundledCapabilities()) {
    if (existing.has(c.slug)) continue;
    db.createCapabilityDef(c);
    seeded.push(c.slug);
  }
  return seeded;
}

/** The EXACT old (archived) provisionJson shape a pre-migration "github" row carries — narrow-matched by
 *  {@link migrateGithubCapabilityToBinary} so an owner-customized row is never touched. */
function isLegacyNpxGithubProvision(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const p = v as { kind?: unknown; command?: unknown; args?: unknown };
  return p.kind === "bundled" && p.command === "npx"
    && Array.isArray(p.args) && p.args.length === 2 && p.args[0] === "-y" && p.args[1] === "@modelcontextprotocol/server-github";
}

/**
 * Boot migration: rewrite an EXISTING install's "github" capability_defs row from the archived
 * `bundled`/npx-`@modelcontextprotocol/server-github` shape to the new `github-binary` shape (agent-tooling
 * P4 follow-on — replacing the archived npx package with a Loom-managed downloaded binary). Seed-if-absent
 * (`seedDefaultCapabilities`) never overwrites an EXISTING row, so a pre-migration install's old row would
 * otherwise sit forever on the dead npm package — this migration is what actually flips it.
 *
 * NARROW + IDEMPOTENT (mirrors `seedSetupProjectRename`'s discipline): only a row whose `kind` is still
 * `bundled` AND whose `provisionJson` is an EXACT match for the old npx shape is rewritten — an
 * owner-customized row (any other command/args, or already migrated) is left completely untouched. A
 * fresh install never has a pre-migration row at all (the row absent ⇒ no-op; `seedDefaultCapabilities`
 * lands the NEW `github-binary` shape directly). Once migrated the row's `kind` is `github-binary`, so a
 * later boot's narrow match no longer applies — safe to call on every boot.
 */
export function migrateGithubCapabilityToBinary(db: Db): boolean {
  const row = db.getCapabilityDefBySlug("github");
  if (!row) return false;
  if (row.kind !== "bundled") return false;
  let provision: unknown;
  try {
    provision = JSON.parse(row.provisionJson);
  } catch {
    return false; // malformed row — leave it alone, not this migration's job to repair
  }
  if (!isLegacyNpxGithubProvision(provision)) return false; // owner-customized — leave it alone
  db.updateCapabilityDefProvision(row.id, "github-binary", JSON.stringify({ kind: "github-binary", version: GITHUB_MCP_SERVER_VERSION }));
  return true;
}
