/**
 * Loom's bundled registry-capability catalog rows — the capabilities analog of profiles/seed.ts's
 * BUNDLED_PROFILES. Ships two: GitHub (kind "github-binary") and "image-gen" (kind "bundled").
 *
 * @decision 3b0c4aef — both seeded as ordinary `capability_defs` rows, not a hardcoded builtin slug,
 * so binding either exercises the SAME generic dispatch + spawn-time secret-env-injection an
 * owner-added row gets; no `pty/host.ts` change needed.
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
 * "image-gen" (kind "npm-pinned", migrated off its original "bundled"/npx form — card e7d6e43b): a pinned
 * npm package, `mcp-imagenate` (npm, MIT, github.com/mimo-3/mcp-imagenate), installed with `npm ci
 * --ignore-scripts` (card 66ab2bc0 — against a COMMITTED `package-lock.json` asset that locks the whole
 * resolved tree, not just this top-level pin) into `<LOOM_HOME>/node/mcp-imagenate/<version>-<lockHash>/`
 * (see `loomNpmPinnedDir` in `npm-pinned.ts`) so its
 * spawn hot path never pays an `npx` re-resolve/download. See `capabilities/npm-pinned.ts` for the
 * download(install)+resolve pipeline and `registry.ts`'s `resolveNpmPinned` for the fs.existsSync-fast-path
 * + background-provision resolution (mirrors `github-binary`). `migrateImageGenCapabilityToNpmPinned`
 * (below) rewrites an EXISTING install's old `bundled`/npx row to this shape at boot — see its own doc for
 * the narrow-match/idempotency contract.
 *
 * @decision b93cfd10 — chosen over several other Gemini-image MCPs surveyed at the time; see the
 * record for the full comparison (unconditional disk-write, output-dir sandboxing, maintenance
 * signal) and the rejected alternatives.
 *
 * @decision a4058e7a — the package is technically MULTI-provider (also OpenAI/BFL FLUX), but only
 * `GEMINI_API_KEY` is ever injected. Do not add `OPENAI_API_KEY`/`GPT_IMAGE_API_KEY`/`BFL_API_KEY`
 * without revisiting this decision — it reopens a multi-provider surface deliberately left unused.
 *
 * Its own output-dir confinement is an ENV VAR (`NANO_BANANA_OUTPUT_DIR`), not a CLI flag like
 * Playwright's `--output-dir` — see `outputDirEnvVar` on `registry.ts`'s "npm-pinned" provision kind for
 * the generic env-var-based scratch-dir injection that requires.
 *
 * "shadcn" (card c3f9ce1f, kind "npm-pinned", direct bin — NEVER bare `npx`, per card 5b1c19c0's measured
 * cold-start: a cold `npx` median was 18.0s against an ~25-27s effective MCP-connect cutoff, little
 * headroom, while the direct `node <bin> mcp` invocation this kind gives measured ~3.1s): the official
 * `shadcn` CLI/MCP (npm, MIT, "Copyright (c) 2023 shadcn", github.com/shadcn-ui/ui at commit
 * 4aaea19d9cff3e0908e12a8c1d504b8c5ec34610 — verified byte-identical, after CRLF normalization, against
 * the npm tarball's own LICENSE.md). Read-only MCP tools only (search/view/list/examples against a
 * registry) — no tool installs anything; component CODE enters a repo only via the agent's own
 * `shadcn add` in its shell, which Loom's ordinary worker-branch merge gate reviews like any other commit.
 * It is useful ONLY in a React+Tailwind project. `args: ["mcp"]` is required (card c3f9ce1f's own
 * extension to the npm-pinned kind, see registry.ts's `CapabilityProvision` doc) — the installed bin is
 * a multi-command entry point (`init`/`add`/`mcp`/…), not a single-purpose MCP server like mcp-imagenate's.
 * SEEDED with an empty `passEnv`: card 5b1c19c0 measured that shadcn's own registry client expands
 * `${VAR}` from its process env into registry URLs/headers named by a repo-controlled `components.json`,
 * which makes ANY env key reaching this row's child a potential exfiltration target. At seed time it gets
 * ONLY the shared launcher's base allowlist (env-isolated-launch.mjs) and nothing row-specific — including
 * no proxy vars, by design (card 188d6a8c scopes proxy credentials out of the base; card 3faaab0d does the
 * same for `npm_config_registry`, which can carry registry userinfo/auth and is NOT needed by this row's
 * runtime — its one-time install is a SEPARATE process that builds its own env directly, see
 * npm-pinned.ts's `ensureNpmPinnedAsync`). This row therefore reaches registries with no proxy configured
 * out of the box — intentional, not an oversight; see the row's own description. THE TRUE INVARIANT: this
 * is a seed-time default, not a permanent lock — a human may widen it later via `PATCH
 * /api/capabilities/:id` (the owner-only `passEnv` escape hatch every capability row has), and every key
 * they add becomes reachable to a repo-controlled `components.json` through the exact same `${VAR}`
 * expansion path. Widening this row's `passEnv` is a deliberate, informed trade a human makes with that
 * exposure in view, not a property this seed guarantees stays empty forever.
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
 * Bumping this constant is a deliberate, reviewed act (mirrors GITHUB_MCP_SERVER_VERSION's own pin) —
 * and, since card 66ab2bc0, ALSO requires regenerating the committed lock asset at
 * `packages/daemon/assets/npm-pinned-locks/mcp-imagenate/<new-version>/package-lock.json` and re-reading
 * its `npm audit` output BEFORE committing the bump; see docs/decisions/66ab2bc0-npm-pinned-lockfile-pin.md
 * ("The bump ritual is extended, not duplicated") for the exact steps — not repeated here.
 */
const MCP_IMAGENATE_VERSION = "0.2.1";

/**
 * The exact `shadcn` (npm) release the "shadcn" seed row is pinned to — the version card 5b1c19c0 actually
 * measured (cold-start timing, the `dist/index.js mcp` entry point, the licence hash). PINNED, not bare
 * `npx -y shadcn@latest`, for the same reason as {@link MCP_IMAGENATE_VERSION}: an unpinned re-resolve
 * would silently run whatever is CURRENTLY "latest" at every spawn. Bumping this constant is a deliberate,
 * reviewed act — and card c3f9ce1f's dotenv-exfil mitigation (see
 * docs/decisions/c3f9ce1f-shadcn-mcp-dotenv-exfil-mitigation.md) depends on THIS version's bundle still
 * importing the literal specifier `@dotenvx/dotenvx`; a bump REQUIRES re-running
 * `test/shadcn-dotenv-exfil-real-spawn.mjs` by hand first (`LOOM_NETWORK_SMOKE=1`) — the hermetic tests
 * cannot catch a future shadcn release changing that import shape. Since card 66ab2bc0, a bump ALSO
 * requires regenerating the committed lock asset at
 * `packages/daemon/assets/npm-pinned-locks/shadcn/<new-version>/package-lock.json` and re-reading its
 * `npm audit` output first — see docs/decisions/66ab2bc0-npm-pinned-lockfile-pin.md for the exact steps,
 * added to this same ritual rather than duplicated here.
 */
const SHADCN_VERSION = "4.23.0";

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
      // Card fafae623: seed rows never carry a passEnv widening — it's an owner-only escape hatch, set
      // later via PATCH, never at seed time.
      passEnv: [],
    },
    {
      slug: "image-gen",
      name: "Image Generation (Gemini/Imagen)",
      description:
        "Inject a per-session Google Gemini/Imagen image-generation MCP so a bound rig (e.g. Web Designer) can generate an image from a text prompt and have it written to disk in the session's own scratch dir — a PNG on disk is then real multimodal input via Claude Code's built-in Read, no extra plumbing needed. Needs a bound connection holding a Gemini API key (Google AI Studio). SPEND-GUARD GAP: Loom's connection rate/spend guard (ConnectionsGuardConfig) covers only the P2 authenticated_request HTTP path, NOT this MCP subprocess path — the MCP calls Google's API directly, outside Loom's own request path entirely. Spend control here rests on opt-in + off-by-default + low-frequency use, plus an OWNER-SET spend cap on the bound key in Google AI Studio/Cloud Console — Loom cannot rate-limit or cap spend on this path itself.",
      transport: "stdio",
      kind: "npm-pinned",
      provisionJson: JSON.stringify({
        kind: "npm-pinned",
        package: "mcp-imagenate",
        version: MCP_IMAGENATE_VERSION,
        binRelativeToPackageJson: "dist/index.js",
        outputDirEnvVar: "NANO_BANANA_OUTPUT_DIR",
      }),
      toolAllowlistJson: JSON.stringify(["mcp__image-gen"]),
      wantsScratchDir: true,
      requiresConnection: true,
      secretEnvVar: "GEMINI_API_KEY",
      // Card fafae623: see the "github" row's identical comment above.
      passEnv: [],
    },
    {
      slug: "shadcn",
      name: "shadcn/ui components",
      description:
        "Inject a per-session, read-only shadcn/ui MCP (search/view/list/examples against a component registry) so a bound rig can look up shadcn/ui components before writing UI code. Useful ONLY in a React + Tailwind project — it works against the project's own components.json when present, or the public @shadcn registry otherwise. NETWORK DEPENDENCY: every call fetches from a registry (the one-time install also fetches from npm) — it does not work offline, and it deliberately fetches WITHOUT any proxy configured (no proxy env var reaches this row's child; its own registry client can be made, by a repo-controlled components.json, to forward an env var's value to an attacker-chosen URL, so this row gets nothing beyond the shared launcher's base allowlist). The MCP tools never write to the repo; component CODE enters the repo only when the agent runs the CLI's own `shadcn add` in its own shell (a tool here only ever returns that command, never executes it) — Loom's ordinary worker-branch merge gate is the real backstop for that third-party source landing in the repo.",
      transport: "stdio",
      kind: "npm-pinned",
      provisionJson: JSON.stringify({
        kind: "npm-pinned",
        package: "shadcn",
        version: SHADCN_VERSION,
        binRelativeToPackageJson: "dist/index.js",
        args: ["mcp"],
      }),
      toolAllowlistJson: JSON.stringify(["mcp__shadcn"]),
      wantsScratchDir: false,
      requiresConnection: false,
      secretEnvVar: null,
      // Card c3f9ce1f: seeded empty — see the module doc comment's "shadcn" paragraph for why (its own
      // registry client can turn any reachable env key into an exfiltration target via a repo-controlled
      // components.json). A human MAY widen it later via PATCH /api/capabilities/:id; every key they add
      // becomes reachable the same way, so widening this row's passEnv is a deliberate, informed trade,
      // not a default to assume stays empty forever.
      passEnv: [],
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

/** The EXACT old (archived) provisionJson shape a pre-migration "image-gen" row carries — narrow-matched
 *  by {@link migrateImageGenCapabilityToNpmPinned} so an owner-customized row is never touched. */
function isLegacyNpxImageGenProvision(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const p = v as { kind?: unknown; command?: unknown; args?: unknown; outputDirEnvVar?: unknown };
  return p.kind === "bundled" && p.command === "npx" && p.outputDirEnvVar === "NANO_BANANA_OUTPUT_DIR"
    && Array.isArray(p.args) && p.args.length === 2 && p.args[0] === "-y" && p.args[1] === `mcp-imagenate@${MCP_IMAGENATE_VERSION}`;
}

/**
 * Boot migration: rewrite an EXISTING install's "image-gen" capability_defs row from the archived
 * `bundled`/npx-`mcp-imagenate` shape to the new `npm-pinned` shape (card e7d6e43b — replacing the
 * per-spawn `npx` re-resolve with a one-time pinned install under `<LOOM_HOME>/node/`). Mirrors
 * {@link migrateGithubCapabilityToBinary}'s exact narrow-match/idempotency contract: only a row whose
 * `kind` is still `bundled` AND whose `provisionJson` is an EXACT match for the old npx shape is
 * rewritten — an owner-customized row (any other command/args, or already migrated) is left completely
 * untouched. A fresh install never has a pre-migration row at all (the row absent ⇒ no-op;
 * `seedDefaultCapabilities` lands the NEW `npm-pinned` shape directly). Once migrated the row's `kind` is
 * `npm-pinned`, so a later boot's narrow match no longer applies — safe to call on every boot.
 */
export function migrateImageGenCapabilityToNpmPinned(db: Db): boolean {
  const row = db.getCapabilityDefBySlug("image-gen");
  if (!row) return false;
  if (row.kind !== "bundled") return false;
  let provision: unknown;
  try {
    provision = JSON.parse(row.provisionJson);
  } catch {
    return false; // malformed row — leave it alone, not this migration's job to repair
  }
  if (!isLegacyNpxImageGenProvision(provision)) return false; // owner-customized — leave it alone
  db.updateCapabilityDefProvision(row.id, "npm-pinned", JSON.stringify({
    kind: "npm-pinned", package: "mcp-imagenate", version: MCP_IMAGENATE_VERSION,
    binRelativeToPackageJson: "dist/index.js", outputDirEnvVar: "NANO_BANANA_OUTPUT_DIR",
  }));
  return true;
}
