/**
 * Loom's bundled registry-capability catalog rows — the capabilities analog of profiles/seed.ts's
 * BUNDLED_PROFILES. Ships two: GitHub (agent-tooling P4 follow-on, board card 3b0c4aef) — the FIRST real
 * credential-tied capability, proving the `requiresConnection`/`{slug, connectionId}` connection-bind path
 * end-to-end — and "image-gen" (board card b93cfd10, provider decided a4058e7a), the SECOND. Both are
 * seeded as ordinary `capability_defs` ROWS — not a fourth/fifth hardcoded builtin slug like
 * browser-testing/document-conversion/deja-corpus, which bypass the credential-tie injection entirely (see
 * `buildMcpServers` in `pty/host.ts`) — so binding either exercises the SAME generic node-package/
 * python-venv/bundled/command/github-binary dispatch + spawn-time secret-env-injection an owner-added row
 * gets. Nothing in `pty/host.ts` needed to change: `getCapabilityCatalog`/`resolveConnectionSecret` already
 * read every `capability_defs` row generically.
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
 *
 * "image-gen" (kind "bundled", NOT github-binary — that kind is github-specific and seed-only): a plain
 * `npx`-resolved MCP, `mcp-imagenate` (npm, MIT, github.com/mimo-3/mcp-imagenate) — chosen over several
 * other Gemini-image MCPs surveyed because (a) it writes generated images to DISK unconditionally
 * (`fs.promises.writeFile`, returning file paths — never base64/URL-only in its response), the hard
 * requirement for this capability to be reviewable/feedable to a separate session at all, (b) its output
 * path is sandboxed against symlink/traversal escape when `NANO_BANANA_OUTPUT_DIR` is set (real
 * `fs.realpathSync` containment checks, not a string-prefix check alone), (c) it's actively maintained (MIT,
 * ~15 GitHub stars, ~1k npm downloads/mo, last published within the month) unlike several
 * higher-profile-looking alternatives whose GitHub source had gone 404 or sat unstarred/templated. It's
 * technically MULTI-provider (also supports OpenAI/BFL FLUX models) — but its model registry only exposes
 * whichever providers have a configured key (`initRegistry` in the package's own `providers/registry.js`),
 * so injecting ONLY `GEMINI_API_KEY` (never `OPENAI_API_KEY`/`GPT_IMAGE_API_KEY`/`BFL_API_KEY`) makes it a
 * pure Gemini/Imagen ("nano-banana") image generator in practice — the OWNER-DECIDED provider (a4058e7a),
 * with no code path to any other provider ever reachable. Its own output-dir confinement is an ENV VAR
 * (`NANO_BANANA_OUTPUT_DIR`), not a CLI flag like Playwright's `--output-dir` — see `outputDirEnvVar` on
 * `registry.ts`'s "bundled" provision kind (a small additive extension added alongside this row) for the
 * generic env-var-based scratch-dir injection that requires.
 */
import type { Db } from "../db.js";
import type { CapabilityDefRow } from "./registry.js";
import { GITHUB_MCP_SERVER_VERSION } from "./github-binary.js";

/**
 * The exact `mcp-imagenate` (npm) release the "image-gen" seed row is pinned to — the version this file's
 * own doc comment above verified (disk-write behavior, NANO_BANANA_OUTPUT_DIR realpathSync sandboxing,
 * provider-gated-by-configured-key model registry). PINNED, not bare `npx -y mcp-imagenate`: an unpinned
 * npx re-resolves to whatever is CURRENTLY "latest" at every spawn, so a future compromised release of the
 * package would silently run with the user's live Gemini key on the very next spawn — and the trust
 * assessment above is specific to THIS version's actual code, not to "whatever mcp-imagenate becomes."
 * Bumping this constant is a deliberate, reviewed act (mirrors GITHUB_MCP_SERVER_VERSION's own pin).
 */
const MCP_IMAGENATE_VERSION = "0.2.1";

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
    {
      slug: "image-gen",
      name: "Image Generation (Gemini/Imagen)",
      description:
        "Inject a per-session Google Gemini/Imagen image-generation MCP so a bound rig (e.g. Web Designer) can generate an image from a text prompt and have it written to disk in the session's own scratch dir — a PNG on disk is then real multimodal input via Claude Code's built-in Read, no extra plumbing needed. Needs a bound connection holding a Gemini API key (Google AI Studio). SPEND-GUARD GAP: Loom's connection rate/spend guard (ConnectionsGuardConfig) covers only the P2 authenticated_request HTTP path, NOT this MCP subprocess path — the MCP calls Google's API directly, outside Loom's own request path entirely. Spend control here rests on opt-in + off-by-default + low-frequency use, plus an OWNER-SET spend cap on the bound key in Google AI Studio/Cloud Console — Loom cannot rate-limit or cap spend on this path itself.",
      transport: "stdio",
      kind: "bundled",
      provisionJson: JSON.stringify({
        kind: "bundled",
        command: "npx",
        args: ["-y", `mcp-imagenate@${MCP_IMAGENATE_VERSION}`],
        outputDirEnvVar: "NANO_BANANA_OUTPUT_DIR",
      }),
      toolAllowlistJson: JSON.stringify(["mcp__image-gen"]),
      wantsScratchDir: true,
      requiresConnection: true,
      secretEnvVar: "GEMINI_API_KEY",
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
