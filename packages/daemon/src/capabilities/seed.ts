/**
 * Loom's bundled registry-capability catalog rows — the capabilities analog of profiles/seed.ts's
 * BUNDLED_PROFILES. v1 ships exactly one: GitHub, the FIRST real credential-tied capability (agent-tooling
 * P4 follow-on, board card 3b0c4aef) — proving the `requiresConnection`/`{slug, connectionId}` connection-
 * bind path end-to-end (P4 v1 hermetically tested that plumbing with a FAKE capability only; this is the
 * first REAL one). Seeded as an ordinary `capability_defs` ROW — not a fourth hardcoded builtin slug like
 * browser-testing/document-conversion/deja-corpus, which bypass the credential-tie injection entirely (see
 * `buildMcpServers` in `pty/host.ts`) — so binding it exercises the SAME generic node-package/python-venv/
 * bundled/command dispatch + spawn-time secret-env-injection an owner-added row gets. Nothing in
 * `pty/host.ts` needed to change: `getCapabilityCatalog`/`resolveConnectionSecret` already read every
 * `capability_defs` row generically.
 *
 * kind "bundled" (not "command"): a `command`-kind row's REST create path (`validateCapabilityDefInput`)
 * REJECTS an unresolvable/nonexistent command at save time — right for a human typing one in by hand, WRONG
 * for a boot-time seed (an offline host, or one with no npm on PATH, must never fail to BOOT over a missing
 * `npx`). "bundled" imposes no such existence check at save time, so the seed always lands the row even when
 * npx isn't resolvable yet; `resolveCapabilityServer`'s later `fs.existsSync` on the stored command then
 * just degrades to log-and-skip THIS spawn — the SAME graceful path every other unresolvable capability
 * takes (a missing Playwright package, a cold markitdown venv) — never a boot crash.
 *
 * "An npx-style command" (per the task): resolves the standard, well-known GitHub MCP server package on
 * demand via `npx -y`, so Loom ships NO bundled npm dependency for it. The row stores the BARE command
 * `"npx"`, NOT a pre-resolved absolute path — CODE-REVIEW FIX: a path frozen in at seed time can never
 * self-heal (a stripped-PATH seeding boot never mounts it again even once npx is later installed; an
 * fnm/nvm/volta shim moved by a Node upgrade 404s silently; a restored DB from another machine carries a
 * dead path). `resolveCapabilityServer`'s bundled branch re-resolves a bare command via `resolveExecutable`
 * at EVERY spawn, exactly like the three hardcoded builtins (Playwright/markitdown/deja) already do — so
 * this row self-heals the moment npx becomes resolvable, never stuck stale. The bound P1 connection's token
 * lands in `GITHUB_PERSONAL_ACCESS_TOKEN`, the env var this standard server package reads — server-side,
 * into the MCP subprocess's OWN env only (never a CLI arg, never the claude process — see
 * `resolveCapabilityServer`).
 */
import type { Db } from "../db.js";
import type { CapabilityDefRow } from "./registry.js";

/** The shipped definition for every bundled capability. */
export function bundledCapabilities(): Omit<CapabilityDefRow, "id" | "createdAt">[] {
  return [
    {
      slug: "github",
      name: "GitHub",
      description:
        "Inject a per-session GitHub MCP so a bound rig can read and act on issues, pull requests, and repo content via the GitHub API. Needs a bound connection holding a GitHub personal access token — that token's OWN scopes are the containment boundary for the granted tool surface (the allowlist grants the whole read+write mcp__github server; the PAT's scopes are the guard).",
      transport: "stdio",
      kind: "bundled",
      provisionJson: JSON.stringify({
        kind: "bundled",
        command: "npx", // bare — resolved (and existence-checked) live at EVERY spawn, see resolveCapabilityServer
        args: ["-y", "@modelcontextprotocol/server-github"],
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
