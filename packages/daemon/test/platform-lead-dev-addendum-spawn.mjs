import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f437d4e9 C4 ROUND 2, folded into C6's own triage note (2026-10-15): the Platform Lead's dev-only
// addendum (the self-hosting daemon_restart/deploy framing + the "don't auto-drive Loom-product
// development" carve-out, stripped from the now-generic /platform-lead skill) is injected at SPAWN TIME
// by `composePlatformLeadStartupPrompt` (sessions/platform-lead-prompt.ts), not via a stored-prompt
// migration — so an agent whose startupPrompt row is hand-edited can never silently lose it, and a
// non-dev install never sees it at all.
//
// C4's round-2 Code Review (fd587b47, gen 417), folded into C6's own scope, found THREE gaps in this file's first pass:
//   1. Every assertion below called `composePlatformLeadStartupPrompt` directly — proving the PURE
//      function's own behavior, never that the three REAL spawn sites (startPlatformLead service.ts,
//      resumeForcedRoleAsFreshClaude, recyclePlatformLead) actually route through it. Fixed by section
//      (d) below: a REAL `startPlatformLead`/`recyclePlatformLead` call, through a fake-pty seam, with the
//      ACTUAL spawned `startupPrompt` asserted (addendum present exactly once under LOOM_DEV=1, absent
//      under LOOM_DEV unset) — per the triage note, one fresh-spawn site and one recycle site (not all
//      three; `resumeForcedRoleAsFreshClaude` is a narrow codex-fallback edge case out of this file's scope).
//   2. The old (c) block's `firstCompose === secondCompose` check CANNOT fail for a pure function given the
//      same inputs — it asserted nothing a bug could ever trip. DROPPED (not replaced): the sibling
//      assertion on the SAME line, `countOccurrences(firstCompose, ADDENDUM) === 1`, is the real,
//      non-vacuous check (a buggy double-append would fail it) and is kept as-is.
//   3. (Documented here, not a code change in THIS file — see `platform-lead/SKILL.md:3` itself, which
//      legitimately says "the Loom Platform Lead": a product+role name allowed by spec §3a. This file's
//      own assertions never scan skill text, so there is nothing for this file to disambiguate — the
//      no-dogfood denylist's own pattern choice is documented in platform-end-user-no-dogfood.mjs.)
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE. Sections (a)-(c) call the real compiled compose function
// directly (pure given `isLoomDev()`'s env read), no Db/pty/daemon involved. Section (d) drives a REAL
// Db + SessionService against a FAKE pty (the shared `_seam-host-fixture.mjs` seam), exactly like
// `platform-lead-recycle.mjs`.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-lead-dev-addendum-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// ===================== (a)-(c): the PURE compose function, called directly =====================
{
  const { composePlatformLeadStartupPrompt, PLATFORM_LEAD_PROMPT_DEV_ADDENDUM } =
    await import("../dist/sessions/platform-lead-prompt.js");

  const RESUME_DOC_PATH = "/tmp/PLATFORM-LEAD-RESUME.md";
  const USER_EDITED_PROMPT = "My own completely rewritten Platform Lead prompt — nothing like the seeded one.";

  // ===================== (a) LOOM_DEV=1: addendum appended, even over a user-edited prompt =====================
  process.env.LOOM_DEV = "1";
  const devComposed = composePlatformLeadStartupPrompt(USER_EDITED_PROMPT, RESUME_DOC_PATH);
  check("(a) LOOM_DEV=1: composed text contains the dev addendum", devComposed.includes(PLATFORM_LEAD_PROMPT_DEV_ADDENDUM));
  check("(a) LOOM_DEV=1: the user-edited prompt text still survives verbatim", devComposed.includes(USER_EDITED_PROMPT));
  check("(a) LOOM_DEV=1: the addendum is appended AFTER the user's own prompt (so it can't be edited away)",
    devComposed.indexOf(USER_EDITED_PROMPT) < devComposed.indexOf(PLATFORM_LEAD_PROMPT_DEV_ADDENDUM));

  // ===================== (a, cont'd) also appended with NO own startupPrompt at all =====================
  const devComposedNoOwn = composePlatformLeadStartupPrompt(undefined, RESUME_DOC_PATH);
  check("(a) LOOM_DEV=1, no own startupPrompt: addendum still appended", devComposedNoOwn.includes(PLATFORM_LEAD_PROMPT_DEV_ADDENDUM));

  // ===================== (b) LOOM_DEV unset / "0": addendum never appears =====================
  delete process.env.LOOM_DEV;
  const nonDevComposed = composePlatformLeadStartupPrompt(USER_EDITED_PROMPT, RESUME_DOC_PATH);
  check("(b) LOOM_DEV unset: composed text does NOT contain the dev addendum", !nonDevComposed.includes(PLATFORM_LEAD_PROMPT_DEV_ADDENDUM));
  check("(b) LOOM_DEV unset: the user's own prompt still survives verbatim", nonDevComposed.includes(USER_EDITED_PROMPT));

  process.env.LOOM_DEV = "0";
  const devZeroComposed = composePlatformLeadStartupPrompt(USER_EDITED_PROMPT, RESUME_DOC_PATH);
  check("(b) LOOM_DEV=0: composed text does NOT contain the dev addendum either", !devZeroComposed.includes(PLATFORM_LEAD_PROMPT_DEV_ADDENDUM));

  // ===================== (c) no duplication across repeated composes of the SAME raw prompt =====================
  // Card fd587b47 (C4's round-2 Code Review, finding 3): the OLD `firstCompose === secondCompose` check here was
  // TAUTOLOGICAL — a pure function given identical inputs cannot produce different outputs, so that
  // assertion could never fail regardless of whether the implementation was correct. DROPPED. The
  // assertion below (occurrence count) is the real, non-vacuous check: a buggy implementation that
  // accumulated state across calls (e.g. appending instead of composing fresh) WOULD trip it.
  process.env.LOOM_DEV = "1";
  const firstCompose = composePlatformLeadStartupPrompt(USER_EDITED_PROMPT, RESUME_DOC_PATH);
  // Simulates a SECOND recycle in a row: every real call site re-reads the agent's own raw startupPrompt
  // fresh (never the previously-composed text), so the input here is the SAME raw USER_EDITED_PROMPT again,
  // not firstCompose.
  const secondCompose = composePlatformLeadStartupPrompt(USER_EDITED_PROMPT, RESUME_DOC_PATH);
  check("(c) the addendum appears EXACTLY once in a single compose", countOccurrences(firstCompose, PLATFORM_LEAD_PROMPT_DEV_ADDENDUM) === 1);
  check("(c) the addendum appears EXACTLY once in a SECOND compose of the same raw prompt (no cross-call accumulation)",
    countOccurrences(secondCompose, PLATFORM_LEAD_PROMPT_DEV_ADDENDUM) === 1);

  delete process.env.LOOM_DEV;
}

// ===================== (d) REAL SPAWN SITES — a pty-spy on startPlatformLead + recyclePlatformLead =====
// Proves the ACTUAL spawned startup text (not just the pure compose function) carries the addendum
// exactly once under LOOM_DEV=1, and never under LOOM_DEV unset — for both a FRESH spawn and a RECYCLE.
{
  const tmpHome = path.join(os.tmpdir(), `loom-lead-addendum-spawn-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
  process.env.LOOM_HOME = tmpHome;
  const sandboxHome = path.join(tmpHome, "home");
  fs.mkdirSync(sandboxHome, { recursive: true });
  process.env.USERPROFILE = sandboxHome;
  process.env.HOME = sandboxHome;
  delete process.env.LOOM_DEV; // phase 1 below needs the default-unset state; each phase sets it explicitly

  const { requireHermeticEnv } = await import("./_guard.mjs");
  requireHermeticEnv();
  const { commitAll } = await import("./_git-commit.mjs");

  const { Db } = await import("../dist/db.js");
  const { PtyHost } = await import("../dist/pty/host.js");
  const { createSeamHost } = await import("./_seam-host-fixture.mjs");
  const { SessionService } = await import("../dist/sessions/service.js");
  const { OrchestrationControl } = await import("../dist/orchestration/control.js");
  const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
  const { seedSetupHome } = await import("../dist/setup/seed.js");
  const { PLATFORM_LEAD_PROMPT_DEV_ADDENDUM } = await import("../dist/sessions/platform-lead-prompt.js");

  const repo = path.join(os.tmpdir(), `loom-lead-addendum-spawn-repo-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# addendum spawn test repo\n");
  execSync("git init -q", { cwd: repo });
  commitAll(repo, "init", "-c user.email=addendum@loom -c user.name=addendum");

  class SeamHost extends createSeamHost(PtyHost) {
    constructor(events) { super(events); this.spawned = []; }
    createPty(opts) { this.spawned.push(opts); return super.createPty(opts); }
  }
  const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

  // ----- (d-dev) LOOM_DEV=1: any platform-role agent is sanctioned (isSanctionedPlatformLeadAgent is
  // unconditionally true in dev) — mirrors platform-lead-recycle.mjs's own simple fixture. -----
  {
    process.env.LOOM_DEV = "1";
    const db = new Db(path.join(tmpHome, "dev.sqlite"));
    const now = new Date().toISOString();
    db.insertProject({ id: "devHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
    db.insertAgent({ id: "devAgent", projectId: "devHome", name: "Platform Lead", startupPrompt: "DEV WARMUP", position: 0, profileId: null });
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());

    const fresh = svc.startPlatformLead("devAgent");
    const freshPrompt = host.spawned.at(-1)?.startupPrompt ?? "";
    check("(d-dev fresh) a REAL startPlatformLead spawn's startupPrompt contains the dev addendum", freshPrompt.includes(PLATFORM_LEAD_PROMPT_DEV_ADDENDUM));
    check("(d-dev fresh) the addendum appears EXACTLY once in the real spawned text", countOccurrences(freshPrompt, PLATFORM_LEAD_PROMPT_DEV_ADDENDUM) === 1);

    const succ = await svc.recyclePlatformLead(fresh.id, "DEV HANDOFF: continue from here");
    const recyclePrompt = host.spawned.at(-1)?.startupPrompt ?? "";
    check("(d-dev recycle) a REAL recyclePlatformLead successor's startupPrompt contains the dev addendum", recyclePrompt.includes(PLATFORM_LEAD_PROMPT_DEV_ADDENDUM));
    check("(d-dev recycle) the addendum appears EXACTLY once in the real recycled text", countOccurrences(recyclePrompt, PLATFORM_LEAD_PROMPT_DEV_ADDENDUM) === 1);
    check("(d-dev recycle) sanity: the successor is a genuinely different session", succ.id !== fresh.id);

    db.close();
    delete process.env.LOOM_DEV;
  }

  // ----- (d-nondev) LOOM_DEV unset: the real non-dev seed path (seedDefaultProfiles + seedSetupHome)
  // seeds the end-user Lead directly, bound to the ungated Platform-lead profile — isSanctionedPlatformLeadAgent
  // resolves it via the SETUP_HOME_LEAD_AGENT_ID_KEY marker stamped by seedSetupHome itself. -----
  {
    const db = new Db(path.join(tmpHome, "nondev.sqlite"));
    seedDefaultProfiles(db);
    seedSetupHome(db);
    const home = db.listAllProjects().find((p) => p.reserved);
    const agent = db.listAgents(home.id)[0];
    db.updateProject(home.id, { repoPath: repo, vaultPath: repo }); // real repo for resolvePlatformLeadResumeDocPath
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());

    const fresh = svc.startPlatformLead(agent.id);
    const freshPrompt = host.spawned.at(-1)?.startupPrompt ?? "";
    check("(d-nondev fresh) a REAL non-dev startPlatformLead spawn's startupPrompt does NOT contain the dev addendum", !freshPrompt.includes(PLATFORM_LEAD_PROMPT_DEV_ADDENDUM));
    check("(d-nondev fresh) sanity: the spawn carries real content (not an empty/broken capture)", freshPrompt.length > 100);

    const succ = await svc.recyclePlatformLead(fresh.id, "NON-DEV HANDOFF: continue from here");
    const recyclePrompt = host.spawned.at(-1)?.startupPrompt ?? "";
    check("(d-nondev recycle) a REAL non-dev recyclePlatformLead successor's startupPrompt does NOT contain the dev addendum", !recyclePrompt.includes(PLATFORM_LEAD_PROMPT_DEV_ADDENDUM));
    check("(d-nondev recycle) sanity: the captured text is substantial, not an empty/broken capture", recyclePrompt.length > 100);
    check("(d-nondev recycle) sanity: the captured text is genuinely the continuation handoff (not a vacuous pass)", recyclePrompt.includes("[loom:continuation]") && recyclePrompt.includes("NON-DEV HANDOFF: continue from here"));
    check("(d-nondev recycle) sanity: the successor is a genuinely different session", succ.id !== fresh.id);

    db.close();
  }

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Platform Lead's dev-only addendum is injected at spawn time (LOOM_DEV=1 only), survives over a user-edited prompt, never appears on a non-dev install, never duplicates across repeated composes of the same raw prompt — and, proven against REAL startPlatformLead/recyclePlatformLead spawns (not just the pure compose function), appears exactly once in the actual spawned startupPrompt under LOOM_DEV=1 (fresh AND recycle) and is absent under LOOM_DEV unset (fresh AND recycle)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
