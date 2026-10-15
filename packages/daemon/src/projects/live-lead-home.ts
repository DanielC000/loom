import type { Project } from "@loom/shared";
import type { Db } from "../db.js";
import { isLoomDev } from "../paths.js";
import { resolveLivePlatformHome } from "../platform/seed.js";
import { resolveLiveSetupHome } from "../setup/seed.js";

/**
 * Card 1731ab5b (epic f437d4e9 C2) — resolve the ONE live platform-tier home for THIS install, by STRICT
 * MUTUAL EXCLUSION on `isLoomDev()`: never a cross-fallback between the two homes. A dev install
 * (LOOM_DEV=1) always resolves the dev "Loom Platform" home (`resolveLivePlatformHome`), or `undefined` if
 * it somehow isn't seeded yet; a non-dev install always resolves the end-user "Platform" home
 * (`resolveLiveSetupHome`), or `undefined`. Falling back from one to the other when the "right" home for
 * this install type is merely ABSENT would be worse than throwing: nothing archives the dev home when
 * LOOM_DEV flips 1 → 0 (e.g. the owner's own `LOOM_DEV=0 pnpm daemon:stable` path), so a stale dev
 * "Loom Platform" row left behind by an earlier LOOM_DEV=1 boot must never silently absorb a non-dev
 * install's escalations/nudges — and a dev install's setup home holds a role:"setup" Setup Assistant, not
 * a Lead, so misrouting an escalation there on a dev install with no (yet-)seeded dev home would be a
 * worse failure than the existing loud throw.
 *
 * This is the ONE place `platformEscalate`, the stuck-manager Lead-notify helper
 * (`notifyLeadOfStuckManager`), and every `PlatformMcpRouter`/orchestration-router tool
 * description/error string that used to hardcode "Loom Platform" resolve their target through — never a
 * bare `.find(p => p.reserved)` (more than one reserved project can coexist, and that shape was a past
 * regression).
 *
 * Lives in its OWN neutral module, never inside `platform/seed.ts` or `setup/seed.ts` themselves, since
 * this function needs both of them.
 *
 * @decision a47dd144 — the two seeders deliberately never import one another.
 */
export function resolveLiveLeadHome(db: Db): Project | undefined {
  return isLoomDev() ? resolveLivePlatformHome(db) : resolveLiveSetupHome(db);
}
