import type { CapabilityGrant } from "@loom/shared";
import { resolveCapabilityServer, type CapabilityDefRow } from "./registry.js";

/**
 * Card e7d6e43b, Code Review Minor: pre-warm an npm-pinned capability's install BEFORE the first session
 * that grants it needs it — so that first session doesn't hit the provision-on-first-spawn cold-skip
 * window (spawn WITHOUT the MCP; only a later spawn, once the install lands, picks it up). Mirrors
 * `python/prewarm.ts`'s `prewarmMarkitdownForProfilesAtBoot` shape exactly, generalized to the npm-pinned
 * KIND (any slug, not one hardcoded capability) since a grant here is slug-based
 * (`Profile.capabilities: CapabilityGrant[]`), not a dedicated boolean field like `documentConversion`.
 *
 * Delegates entirely to {@link resolveCapabilityServer} (the SAME generic dispatch `buildMcpServers` uses
 * at spawn time, and the SAME one the provisioning-status REST retry route calls) — this module only
 * decides WHICH rows are worth kicking and WHEN (boot), never duplicates the install/background-kick
 * logic itself. Fully async/best-effort/off-the-event-loop, by construction (resolveCapabilityServer's
 * own `npm-pinned` branch never blocks — see `registry.ts`'s `resolveNpmPinned`).
 */

/** The narrow daemon-db surface the boot pre-warm needs (kept structural so it's trivially fakeable in a
 *  test, mirrors `python/prewarm.ts`'s `PrewarmDeps`). */
export interface NpmPinnedPrewarmDeps {
  listCapabilityDefs(): CapabilityDefRow[];
  listProfiles(): { capabilities?: CapabilityGrant[] }[];
}

/**
 * At daemon boot, pre-warm every "npm-pinned" capability_defs row that at least one profile grants.
 * Best-effort + fully off the event loop (delegates to `resolveCapabilityServer`'s own background kick);
 * a no-op when no npm-pinned row exists, or none is granted anywhere. Returns the slugs it kicked (for
 * the boot log / tests) — a slug that was already warm (fs.existsSync hit) is still RETURNED (the call
 * was still made; `resolveCapabilityServer` itself is what decides whether that call actually kicks
 * anything), consistent with `prewarmMarkitdownForProfilesAtBoot`'s own boolean "was a prewarm attempted"
 * semantics generalized to a list.
 */
export function prewarmNpmPinnedForProfilesAtBoot(db: NpmPinnedPrewarmDeps): string[] {
  const npmPinnedRows = db.listCapabilityDefs().filter((r) => r.kind === "npm-pinned");
  if (npmPinnedRows.length === 0) return [];
  const grantedSlugs = new Set<string>();
  for (const p of db.listProfiles()) {
    for (const g of p.capabilities ?? []) grantedSlugs.add(g.slug);
  }
  const kicked: string[] = [];
  for (const row of npmPinnedRows) {
    if (!grantedSlugs.has(row.slug)) continue;
    resolveCapabilityServer(row, {});
    kicked.push(row.slug);
  }
  return kicked;
}
