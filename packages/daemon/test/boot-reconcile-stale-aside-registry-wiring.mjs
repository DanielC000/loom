import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ad34efb5 round 2 (Minor 3a): WIRING proof that SessionService.reconcileOrchestrationOnBoot passes
// the real repoKeysByProject registry map into listStaleAsideWorktrees — a regression that dropped that
// second argument (degrading to primary-axis-only) would miss a SECONDARY-repo-axis stale-aside leftover
// and must go RED here. REAL filesystem under a temp LOOM_HOME, NO claude and NO live daemon.
//
// Method: seed a project with a REGISTERED secondary repoKey, create a secondary-axis `.stale-<ts>`
// leaf under it, run reconcileOrchestrationOnBoot(), and capture its own `[reconcile] N renamed-aside
// stale worktree dir(s) found` warn. A direct, UNREGISTERED call to listStaleAsideWorktrees(WORKTREES_DIR)
// (no registry — exactly what "dropping the second argument" degrades to) is run in CONTRAST: it must
// NOT find the same secondary-axis leaf, proving the registry argument is what makes the difference
// reconcileOrchestrationOnBoot's own warn depends on.
import fs from "node:fs";
import path from "node:path";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-brsaw-home-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { listStaleAsideWorktrees, resolveWorktreePath } = await import("../dist/git/worktrees.js");
const { WORKTREES_DIR } = await import("../dist/paths.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const warns = [];
const realWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(" ")); };

const now = new Date().toISOString();
const db = new Db(path.join(process.env.LOOM_HOME, "loom.db"));
const projId = "projBrsawWiring";
const repoKey = "secondary-wiring-repo";

try {
  db.insertProject({
    id: projId, name: "BR Stale-Aside Wiring", repoPath: process.env.LOOM_HOME, vaultPath: process.env.LOOM_HOME,
    config: {}, createdAt: now, archivedAt: null,
    repos: [{ key: repoKey, path: process.env.LOOM_HOME }],
  });

  const secondaryCleanPath = resolveWorktreePath(projId, "taskWiring-secondary", repoKey);
  const secondaryStalePath = `${secondaryCleanPath}.stale-1700000000030`;
  fs.mkdirSync(secondaryStalePath, { recursive: true });
  fs.writeFileSync(path.join(secondaryStalePath, "leftover.txt"), "half-removed orphan content\n");

  // CONTRAST: a direct call with NO registry (what a dropped-second-argument regression degrades to)
  // must NOT find the secondary-axis leaf — proves the registry argument is load-bearing for this case.
  const unregisteredEntries = listStaleAsideWorktrees(WORKTREES_DIR);
  check("(contrast) WITHOUT the registry, the secondary-axis leaf is NOT found (this is exactly what a dropped-argument regression degrades to)",
    !unregisteredEntries.find((e) => e.path === secondaryStalePath));

  const sessions = new SessionService(db, {}, new OrchestrationControl());
  const result = await sessions.reconcileOrchestrationOnBoot();
  check("(wiring) reconcileOrchestrationOnBoot ran without throwing", typeof result === "object" && result !== null);
  const staleWarn = warns.find((w) => w.includes("renamed-aside stale worktree dir"));
  check("(wiring) reconcileOrchestrationOnBoot's OWN warn fires for the secondary-axis leaf — proves it passed the real registry into listStaleAsideWorktrees, not degraded to primary-axis-only",
    !!staleWarn && /\b[1-9]\d*\b/.test(staleWarn));

  fs.rmSync(secondaryStalePath, { recursive: true, force: true });
} finally {
  console.warn = realWarn;
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — reconcileOrchestrationOnBoot's renamed-aside stale-leftover advisory is wired to the REAL repoKeysByProject registry, not degraded to primary-axis-only (a secondary-repo-axis leaf is found and warned about)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
