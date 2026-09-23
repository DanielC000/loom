import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 097902b9 (child F of epic f69cabc7 "all projects, from now on"): `project_init` (the setup
// operator's only host-write — see setup/bootstrap.ts) now seeds a fresh CODE project's decision-record
// store (`docs/decisions/README.md`) from birth, via `bootstrapProjectDir`'s own `seedDecisionRecordStore`
// step — the single chokepoint shared by every `project_init`-equivalent caller (mcp/setup.ts,
// mcp/platform.ts, the human REST route in gateway/server.ts). This proves:
//   (1) a `kind:"git"` project gets a REAL `docs/decisions/README.md` file (not just a bare directory —
//       git does not track an empty one, so a file is what makes the store durable across a commit/
//       checkout round-trip), and `writeSessionSettings` — the exact daemon-side gate `pty/host.ts`'s
//       `createPty` calls at spawn — WIRES the decision-records Read hook for that repo (card 5244adc2's
//       gate: `anyDecisionRecordStoreExists`).
//   (2) a `kind:"vault"` project is deliberately LEFT UNSEEDED (child C, card a4760fc8, has not yet ruled
//       on where a vault project's store lives) — no `docs/decisions` at all, and `writeSessionSettings`
//       correspondingly wires NO Read hook for it, same as before this card.
//   (3) the seeded README stays GENERIC — no Loom-specific card id or internal path, since it ships into
//       an end user's own project repo.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE — a real (but tiny, local) `git init`, no daemon, no network.
// Run: 1) build (turbo builds shared first), 2) node test/project-init-decision-record-store.mjs
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = mkdtempManaged("loom-project-init-decrec-");
requireHermeticEnv();

const { ensureDirs, WORKSPACE_ROOT } = await import("../dist/paths.js");
const { bootstrapProjectDir } = await import("../dist/setup/bootstrap.js");
const { writeSessionSettings } = await import("../dist/pty/claude-settings.js");

ensureDirs();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const perm = { mode: "acceptEdits", allow: [], deny: [] };

// Reads back the PostToolUse hook groups written for `repoPath`, under a fresh session id each call so
// no two calls in this file can collide on the same settings file.
let n = 0;
function hookGroupsFor(repoPath) {
  const sessionId = `project-init-decrec-${++n}`;
  const settingsPath = writeSessionSettings(sessionId, perm, "test-hook-token", undefined, repoPath);
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  return settings.hooks?.PostToolUse ?? [];
}
function hasReadHookGroup(groups) {
  return groups.some((g) => g.matcher === "Read" && g.hooks?.some((h) => /decision-records\.mjs/.test(h.command)));
}

// ===================== (1) kind:"git" (default) — seeded, and the hook wires =====================
{
  const boot = await bootstrapProjectDir({ name: "Fresh Code Project", git: true });
  check("(1) bootstrapProjectDir(git) ok", boot.ok === true);
  if (boot.ok) {
    const dir = boot.dir;
    check("(1) created strictly under WORKSPACE_ROOT", dir.startsWith(path.resolve(WORKSPACE_ROOT) + path.sep));
    check("(1) git-initialized (.git present)", fs.existsSync(path.join(dir, ".git")));

    const storeDir = path.join(dir, "docs", "decisions");
    check("(1) docs/decisions directory exists (the anyDecisionRecordStoreExists check)", fs.existsSync(storeDir));
    const readmePath = path.join(storeDir, "README.md");
    check("(1) docs/decisions/README.md is a REAL FILE, not just an empty dir "
      + "(git does not track an empty directory — a bare mkdir would not survive a commit/checkout round-trip)",
      fs.existsSync(readmePath) && fs.statSync(readmePath).isFile());
    const readme = fs.readFileSync(readmePath, "utf8");
    check("(1) README is non-trivial content", readme.length > 40);
    check("(1) README stays GENERIC — no Loom-specific product name", !/\bLoom\b/.test(readme));
    check("(1) README points at the shipped /worker doctrine for the writing rules", /\/worker\b/.test(readme));

    const groups = hookGroupsFor(dir);
    check("(1) writeSessionSettings(repoPath = the fresh project dir): a spawn's settings WIRE the "
      + "decision-records Read hook (proves anyDecisionRecordStoreExists recognises the seeded store)",
      hasReadHookGroup(groups));
  }
}

// ===================== (2) kind:"vault" — deliberately left unseeded (child C not yet ruled) =====================
{
  const boot = await bootstrapProjectDir({ name: "My Research Notes", git: false });
  check("(2) bootstrapProjectDir(vault) ok", boot.ok === true);
  if (boot.ok) {
    const dir = boot.dir;
    check("(2) NOT git-initialized (no .git)", !fs.existsSync(path.join(dir, ".git")));
    check("(2) docs/decisions is NOT created for a vault project (deferred to card a4760fc8)",
      !fs.existsSync(path.join(dir, "docs", "decisions")));

    const groups = hookGroupsFor(dir);
    check("(2) writeSessionSettings(repoPath = the vault project dir): NO Read hook is wired "
      + "(no store exists there — same as before this card)",
      !hasReadHookGroup(groups));
  }
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
await finishAndExit(process.exitCode);
