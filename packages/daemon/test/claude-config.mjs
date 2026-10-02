// Hermetic unit test for pty/claude-config.ts — the contract of fast-follow #1:
// ensureTrusted honors CLAUDE_CONFIG_DIR (writes <dir>/.claude.json), falls back to
// <homedir>/.claude.json when it is unset, and NEVER mutates the real ~/.claude.json.
//
// This is a pure in-process test: no daemon, no real `claude` spawn — so it is deterministic
// and cannot pollute the real environment. (It replaces the old real-claude spawn-scope test,
// which could not run under an isolated CLAUDE_CONFIG_DIR: that env var breaks Claude's
// --mcp-config suppression of the user-level ~/.mcp.json enable-prompt, blocking an unattended
// spawn — a known upstream bug, logged in the vault.) The real-claude §6 guarantee is still
// covered: integration-e2e.mjs proves a real session reaches its project's tasks through the
// real pty/host.ts --mcp-config injection, and mcp-scope.mjs proves the session-URL scoping
// isolates projects (A never sees B; writes are scoped).
//
// Run after build: node test/claude-config.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  ensureTrusted, discoverProjectMcpServerNames, claudeCliProjectKey,
  __setGitMainCheckoutRootResolverForTest, __setOpenSyncForTest,
} from "../dist/pty/claude-config.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const keyFor = (dir) => path.resolve(dir).replace(/\\/g, "/");
const entryFor = (cfgPath, key) => JSON.parse(fs.readFileSync(cfgPath, "utf8")).projects?.[key];
const trusted = (cfgPath, key) => {
  const e = entryFor(cfgPath, key);
  return e?.hasTrustDialogAccepted === true && e?.hasCompletedProjectOnboarding === true;
};
const declinedExternalImport = (cfgPath, key) => {
  const e = entryFor(cfgPath, key);
  return e?.hasClaudeMdExternalIncludesApproved === false && e?.hasClaudeMdExternalIncludesWarningShown === true;
};
const noTmpLeft = (dir) => fs.readdirSync(dir).every((f) => !f.includes(".loom.tmp"));

const root = path.join(os.tmpdir(), `loom-claude-config-test-${Date.now()}-${process.pid}`);
fs.mkdirSync(root, { recursive: true });

// Real ~/.claude.json path (captured with the REAL homedir, before any env tweaks). We do NOT diff
// its whole content before/after (card ccd6153c): that file is a live, host-shared resource — any
// OTHER concurrently-spawned Loom session's own real ensureTrusted() call (createPty's spawn
// chokepoint calls it on every fresh/resume/fork/recycle/boot) can legitimately write its own entry
// into it while THIS test runs, and a whole-file byte census would flag that unrelated, correct
// activity as a failure of this test. Instead we track only the specific keys THIS test's own
// ensureTrusted() calls could have written here — every one of them lives under `root`, so no real
// caller could ever collide with one — and assert their ABSENCE below, not that nothing at all changed.
const realJson = path.join(os.homedir(), ".claude.json");
const ownDirs = [];

const saved = { cfg: process.env.CLAUDE_CONFIG_DIR, up: process.env.USERPROFILE, home: process.env.HOME };
const restoreEnv = () => {
  for (const [k, v] of [["CLAUDE_CONFIG_DIR", saved.cfg], ["USERPROFILE", saved.up], ["HOME", saved.home]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};

try {
  // === 1. CLAUDE_CONFIG_DIR SET → trust lands in <dir>/.claude.json (fresh file created). ===
  const configDir = path.join(root, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const isoJson = path.join(configDir, ".claude.json");
  const projA = path.join(root, "projA");
  process.env.CLAUDE_CONFIG_DIR = configDir;

  ownDirs.push(projA);
  ensureTrusted(projA);
  check("CLAUDE_CONFIG_DIR set → trust written to <dir>/.claude.json", fs.existsSync(isoJson) && trusted(isoJson, keyFor(projA)));
  check("CLAUDE_CONFIG_DIR set → atomic temp file cleaned up (no .loom.tmp left)", noTmpLeft(configDir));
  check("CLAUDE_CONFIG_DIR set → a fresh (undecided) entry gets the external-import dialog declined",
    declinedExternalImport(isoJson, keyFor(projA)));

  // idempotent: already-trusted dir is a no-op and stays trusted
  ensureTrusted(projA);
  check("CLAUDE_CONFIG_DIR set → idempotent re-call keeps it trusted", trusted(isoJson, keyFor(projA)));
  check("CLAUDE_CONFIG_DIR set → idempotent re-call keeps the external-import decline", declinedExternalImport(isoJson, keyFor(projA)));

  // a second project lands its own entry; both coexist, still no temp leftover (unique-suffix
  // temp name — fast-follow #3 — means concurrent calls can't collide on a shared .loom.tmp).
  const projB = path.join(root, "projB");
  ownDirs.push(projB);
  ensureTrusted(projB);
  check("CLAUDE_CONFIG_DIR set → second project trusted, both entries coexist",
    trusted(isoJson, keyFor(projA)) && trusted(isoJson, keyFor(projB)));
  check("CLAUDE_CONFIG_DIR set → still no .loom.tmp left after multiple writes", noTmpLeft(configDir));

  // === 2. CLAUDE_CONFIG_DIR UNSET → falls back to <homedir>/.claude.json (unchanged behavior). ===
  // Redirect homedir to a temp dir so we exercise the real fallback path WITHOUT risking the
  // real file. (os.homedir() reads USERPROFILE on Windows — verified honored in-process.)
  const fakeHome = path.join(root, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  if (os.homedir() === fakeHome) {
    const projC = path.join(root, "projC");
    ownDirs.push(projC);
    ensureTrusted(projC);
    const homeJson = path.join(fakeHome, ".claude.json");
    check("CLAUDE_CONFIG_DIR unset → trust written to <homedir>/.claude.json", fs.existsSync(homeJson) && trusted(homeJson, keyFor(projC)));
  } else {
    console.log("SKIP  unset-branch — os.homedir() not redirectable here; not risking the real file");
  }

  // === 4. The MCP-prompt prevention (card dacb8571): a worktree that inherits a `.mcp.json` up-tree
  // (the production layout — every worktree lives under home, which holds ~/.mcp.json) gets those
  // server names pre-written to disabledMcpjsonServers so the unattended boot never blocks on the
  // "N new MCP servers found — enable?" prompt. Hermetic: HOME→fakeHome bounds the up-tree walk and
  // makes os.homedir() deterministic; CLAUDE_CONFIG_DIR isolates the .claude.json we assert on. ===
  const mcpHome = path.join(root, "mcphome");
  fs.mkdirSync(mcpHome, { recursive: true });
  process.env.USERPROFILE = mcpHome;
  process.env.HOME = mcpHome;
  if (os.homedir() === mcpHome) {
    const mcpConfigDir = path.join(root, "mcpconfig");
    fs.mkdirSync(mcpConfigDir, { recursive: true });
    const mcpIsoJson = path.join(mcpConfigDir, ".claude.json");
    process.env.CLAUDE_CONFIG_DIR = mcpConfigDir;

    // ~/.mcp.json with two servers — exactly the docker/sentry shape the real CLI walks up-tree to find.
    fs.writeFileSync(path.join(mcpHome, ".mcp.json"),
      JSON.stringify({ mcpServers: { docker: { command: "x" }, sentry: { command: "y" } } }));

    // 4a. Discovery walks up from a nested worktree to home and collects both server names.
    const wt = path.join(mcpHome, ".loom", "worktrees", "abc", "sub");
    fs.mkdirSync(wt, { recursive: true });
    ownDirs.push(wt);
    const discovered = discoverProjectMcpServerNames(wt).sort();
    check("discoverProjectMcpServerNames → finds up-tree ~/.mcp.json servers",
      discovered.length === 2 && discovered[0] === "docker" && discovered[1] === "sentry");

    // 4b. ensureTrusted pre-writes them to disabledMcpjsonServers (+ trust, + empty enabled list).
    ensureTrusted(wt);
    const e = entryFor(mcpIsoJson, keyFor(wt));
    const disabled = (e?.disabledMcpjsonServers ?? []).slice().sort();
    check("ensureTrusted → worktree entry trusted AND docker/sentry in disabledMcpjsonServers",
      trusted(mcpIsoJson, keyFor(wt)) && disabled.length === 2 && disabled[0] === "docker" && disabled[1] === "sentry"
      && Array.isArray(e?.enabledMcpjsonServers) && e.enabledMcpjsonServers.length === 0 && e?.enableAllProjectMcpServers === false);

    // 4c. Idempotent: a re-call writes nothing new (fast-path: trusted + all servers already disabled).
    const before = fs.readFileSync(mcpIsoJson);
    ensureTrusted(wt);
    check("ensureTrusted → idempotent re-call leaves the config byte-identical", fs.readFileSync(mcpIsoJson).equals(before));

    // 4d. An existing manual disable is MERGED (union), not clobbered.
    const wt2 = path.join(mcpHome, ".loom", "worktrees", "def", "sub");
    fs.mkdirSync(wt2, { recursive: true });
    ownDirs.push(wt2);
    const cfg = JSON.parse(fs.readFileSync(mcpIsoJson, "utf8"));
    cfg.projects ??= {};
    cfg.projects[keyFor(wt2)] = { disabledMcpjsonServers: ["prior"] };
    fs.writeFileSync(mcpIsoJson, JSON.stringify(cfg, null, 2));
    ensureTrusted(wt2);
    const merged = (entryFor(mcpIsoJson, keyFor(wt2))?.disabledMcpjsonServers ?? []).slice().sort();
    check("ensureTrusted → merges (unions) with a pre-existing disabledMcpjsonServers entry",
      merged.length === 3 && merged[0] === "docker" && merged[1] === "prior" && merged[2] === "sentry");

    // 4e. A worktree with NO up-tree .mcp.json gets a trust-only entry (byte-identical to pre-fix).
    const plainHome = path.join(root, "plainhome");
    fs.mkdirSync(plainHome, { recursive: true });
    process.env.USERPROFILE = plainHome; process.env.HOME = plainHome;
    if (os.homedir() === plainHome) {
      const plainCfgDir = path.join(root, "plainconfig");
      fs.mkdirSync(plainCfgDir, { recursive: true });
      process.env.CLAUDE_CONFIG_DIR = plainCfgDir;
      const plainWt = path.join(plainHome, ".loom", "worktrees", "ghi");
      fs.mkdirSync(plainWt, { recursive: true });
      ownDirs.push(plainWt);
      ensureTrusted(plainWt);
      const pe = entryFor(path.join(plainCfgDir, ".claude.json"), keyFor(plainWt));
      check("ensureTrusted → no up-tree .mcp.json ⇒ trust-only entry, no MCP keys",
        pe?.hasTrustDialogAccepted === true && !("disabledMcpjsonServers" in pe) && !("enabledMcpjsonServers" in pe));
    }
  } else {
    console.log("SKIP  mcp-prevention — os.homedir() not redirectable here; not risking the real file");
  }

  // === 5. External-import dialog (card e789ef3b): decline ONLY when genuinely undecided; NEVER
  // overwrite an existing decision (ours or a human's own interactive `claude` run); and a
  // pre-existing trusted entry with no import flags at all (the upgrade-path case — an older Loom
  // build, or a human's own prior trust-only run) gets the decline written on its next ensureTrusted
  // call, not skipped by the fast path. ===
  const eiHome = path.join(root, "eihome");
  fs.mkdirSync(eiHome, { recursive: true });
  process.env.USERPROFILE = eiHome; process.env.HOME = eiHome;
  if (os.homedir() === eiHome) {
    const eiCfgDir = path.join(root, "eiconfig");
    fs.mkdirSync(eiCfgDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = eiCfgDir;
    const eiJson = path.join(eiCfgDir, ".claude.json");

    // 5a. Upgrade path: an entry already trusted by an OLDER Loom build (hasTrustDialogAccepted:true,
    // no import flags at all) still gets the decline written on the next ensureTrusted call — the
    // pre-fix `isTrusted`-only fast path would have wrongly treated this as "nothing to do".
    const upgradeDir = path.join(eiHome, "upgrade");
    fs.mkdirSync(upgradeDir, { recursive: true });
    ownDirs.push(upgradeDir);
    fs.writeFileSync(eiJson, JSON.stringify({
      projects: { [keyFor(upgradeDir)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }));
    ensureTrusted(upgradeDir);
    check("ensureTrusted → pre-existing trusted entry with NO import flags gets the decline written (upgrade path)",
      declinedExternalImport(eiJson, keyFor(upgradeDir)));

    // 5a2. Card 17237fba: isTrusted now checks ONLY hasTrustDialogAccepted (hasCompletedProjectOnboarding
    // is stripped from every real project entry by the CLI itself on every save, so requiring it made the
    // fast path dead). Prove that dropping it does NOT skip anything load-bearing: an entry carrying
    // hasTrustDialogAccepted:true alone (no hasCompletedProjectOnboarding at all — the realistic
    // CLI-stripped shape, not the old upgradeDir fixture above which still has both legacy flags) and NO
    // import decision must still reach the lock and get the import decline written.
    const strippedDir = path.join(eiHome, "stripped");
    fs.mkdirSync(strippedDir, { recursive: true });
    ownDirs.push(strippedDir);
    let cfg5a2 = JSON.parse(fs.readFileSync(eiJson, "utf8"));
    cfg5a2.projects[keyFor(strippedDir)] = { hasTrustDialogAccepted: true };
    fs.writeFileSync(eiJson, JSON.stringify(cfg5a2, null, 2));
    ensureTrusted(strippedDir);
    const strippedEntry = entryFor(eiJson, keyFor(strippedDir));
    check("ensureTrusted → trusted-but-onboarding-flag-absent entry still gets the import decline written",
      declinedExternalImport(eiJson, keyFor(strippedDir)) && strippedEntry?.hasTrustDialogAccepted === true);

    // 5a3. The other half of the same fix: once hasTrustDialogAccepted AND the import decision are BOTH
    // already present (no hasCompletedProjectOnboarding at all — again the realistic CLI-stripped shape),
    // the fast path must actually ENGAGE and skip the write entirely (byte-identical re-call, no lock
    // taken). Under the OLD two-flag isTrusted this fixture could NEVER reach the fast path (onboarding is
    // never present on a real entry), so it would have rewritten the file on every single call forever —
    // this is the dead-fast-path perf claim from card 17237fba's own body, proven directly.
    // "No lock taken" is asserted via the __setOpenSyncForTest seam (withTrustLock's lock-acquire is the
    // ONLY call to this fn) rather than inferred from byte-identity alone — byte-identity alone proves
    // the FILE wasn't rewritten, not that the lock-acquiring path was never entered; this call-count is
    // what actually goes RED if the outer lock-free fast path (the isFullyDecided short-circuit before
    // withTrustLock, above) is ever removed (card 6f52c3f5).
    const fullyStrippedDir = path.join(eiHome, "fully-stripped");
    fs.mkdirSync(fullyStrippedDir, { recursive: true });
    ownDirs.push(fullyStrippedDir);
    let cfg5a3 = JSON.parse(fs.readFileSync(eiJson, "utf8"));
    cfg5a3.projects[keyFor(fullyStrippedDir)] = {
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true,
    };
    fs.writeFileSync(eiJson, JSON.stringify(cfg5a3, null, 2));
    const beforeFullyStripped = fs.readFileSync(eiJson);
    let fullyStrippedOpenCalls = 0;
    __setOpenSyncForTest((p, flags) => { fullyStrippedOpenCalls++; return fs.openSync(p, flags); });
    ensureTrusted(fullyStrippedDir);
    __setOpenSyncForTest();
    check("ensureTrusted → trusted + import-decided entry with NO onboarding flag is a pure no-op (fast path now engages)",
      fs.readFileSync(eiJson).equals(beforeFullyStripped));
    check("ensureTrusted → the fast path never opens the .loom-lock file at all (0 openSync calls)",
      fullyStrippedOpenCalls === 0);

    // 5b. Never overwrite an EXISTING explicit approval — a human clicked "Yes, allow external imports"
    // for their own folder; Loom must never silently revoke that.
    const approvedDir = path.join(eiHome, "approved");
    fs.mkdirSync(approvedDir, { recursive: true });
    ownDirs.push(approvedDir);
    let cfg5 = JSON.parse(fs.readFileSync(eiJson, "utf8"));
    cfg5.projects[keyFor(approvedDir)] = {
      hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true,
      hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true,
    };
    fs.writeFileSync(eiJson, JSON.stringify(cfg5, null, 2));
    const beforeApproved = fs.readFileSync(eiJson);
    ensureTrusted(approvedDir);
    const approvedEntry = entryFor(eiJson, keyFor(approvedDir));
    check("ensureTrusted → an EXISTING explicit approval is left untouched, never overwritten",
      approvedEntry?.hasClaudeMdExternalIncludesApproved === true && fs.readFileSync(eiJson).equals(beforeApproved));

    // 5c. Never overwrite an EXISTING explicit decline either — idempotent, byte-identical re-call.
    const declinedDir = path.join(eiHome, "declined");
    fs.mkdirSync(declinedDir, { recursive: true });
    ownDirs.push(declinedDir);
    ensureTrusted(declinedDir); // writes the decline fresh
    check("ensureTrusted → a fresh entry in this sub-scenario is declined too", declinedExternalImport(eiJson, keyFor(declinedDir)));
    const beforeDeclined = fs.readFileSync(eiJson);
    ensureTrusted(declinedDir); // re-call: already decided → must be a pure no-op
    check("ensureTrusted → an EXISTING explicit decline is left untouched (byte-identical re-call)",
      fs.readFileSync(eiJson).equals(beforeDeclined));
  } else {
    console.log("SKIP  external-import decline — os.homedir() not redirectable here; not risking the real file");
  }

  // === 6. Round-2 canonical-git-root keying (card e789ef3b, round 2): the installed `claude` CLI reads
  // the external-import dialog's decision from the CANONICAL git root (for a linked worktree, the MAIN
  // checkout), not path.resolve(cwd) — so the decline must land under THAT key, never the worktree's own
  // path, while trust/MCP keep their existing (unchanged) worktree-path keying. ===
  const giCfgDir = path.join(root, "giconfig");
  fs.mkdirSync(giCfgDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = giCfgDir;
  const giJson = path.join(giCfgDir, ".claude.json");

  const giRepo = path.join(root, "gitrepo-main");
  fs.mkdirSync(giRepo, { recursive: true });
  ownDirs.push(giRepo);
  execSync(`git init -q && git config user.email e789@loom && git config user.name e789 && git commit -q -m init --allow-empty`, { cwd: giRepo });

  const giWt = path.join(root, "gitrepo-wt-a");
  ownDirs.push(giWt);
  execSync(`git worktree add -q -b e789-wt-a "${giWt}" HEAD`, { cwd: giRepo });
  // Ground truth for "the main checkout's key" — derived from git itself (git rev-parse
  // --git-common-dir's PARENT), never assumed to equal `giRepo`'s own plain spelling.
  const giCommonDir = execSync(`git rev-parse --git-common-dir`, { cwd: giWt }).toString().trim();
  const giMainKey = keyFor(path.dirname(giCommonDir));

  // 6a. A fresh linked worktree: trust/MCP land under the WORKTREE's own key (unchanged); the
  // external-import decline lands under the MAIN CHECKOUT's key instead — NOT the worktree's key.
  ensureTrusted(giWt);
  check("linked worktree → trust still written under the worktree's OWN key",
    trusted(giJson, keyFor(giWt)));
  check("linked worktree → the worktree's OWN key does NOT carry the import decline (moved off it)",
    !("hasClaudeMdExternalIncludesWarningShown" in (entryFor(giJson, keyFor(giWt)) ?? {})));
  check("linked worktree → the import decline lands under the MAIN CHECKOUT's canonical key",
    declinedExternalImport(giJson, giMainKey));
  check("linked worktree → the main checkout's entry does NOT also get trust fields from this call",
    !("hasTrustDialogAccepted" in (entryFor(giJson, giMainKey) ?? {})));
  check("claudeCliProjectKey(worktree) resolves to the main checkout's key, not the worktree's own path",
    claudeCliProjectKey(giWt) === giMainKey && claudeCliProjectKey(giWt) !== keyFor(giWt));

  // 6b. An EXISTING human decision already recorded under the main checkout's canonical key (e.g. the
  // owner's own interactive `claude` run at the repo root) must be left untouched by a worktree spawn —
  // never silently revoked just because a second linked worktree happens to be undecided itself.
  const giWt2 = path.join(root, "gitrepo-wt-b");
  ownDirs.push(giWt2);
  execSync(`git worktree add -q -b e789-wt-b "${giWt2}" HEAD`, { cwd: giRepo });
  let cfg6b = JSON.parse(fs.readFileSync(giJson, "utf8"));
  cfg6b.projects[giMainKey] = {
    hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true,
  };
  fs.writeFileSync(giJson, JSON.stringify(cfg6b, null, 2));
  ensureTrusted(giWt2);
  const giMainEntryAfter = entryFor(giJson, giMainKey);
  check("second linked worktree → an EXISTING human approval on the main checkout's key is untouched",
    giMainEntryAfter?.hasClaudeMdExternalIncludesApproved === true);
  check("second linked worktree → its OWN key still gets trusted independently",
    trusted(giJson, keyFor(giWt2)));

  // 6c. The reviewer's missing case (Code Review round 1): an entry that already carries an explicit
  // Approved:true but has NOT YET been trusted (no hasCompletedProjectOnboarding) must keep Approved:true
  // after ensureTrusted ALSO trusts it — the merge must never drop a prior decision while adding trust.
  const partialDir = path.join(root, "partial-approved");
  fs.mkdirSync(partialDir, { recursive: true });
  ownDirs.push(partialDir);
  let cfg6c = JSON.parse(fs.readFileSync(giJson, "utf8"));
  cfg6c.projects[keyFor(partialDir)] = {
    hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true,
  };
  fs.writeFileSync(giJson, JSON.stringify(cfg6c, null, 2));
  ensureTrusted(partialDir);
  const partialEntry = entryFor(giJson, keyFor(partialDir));
  check("Approved:true WITHOUT hasCompletedProjectOnboarding is preserved, and trust is added on top",
    partialEntry?.hasClaudeMdExternalIncludesApproved === true
    && partialEntry?.hasTrustDialogAccepted === true
    && partialEntry?.hasCompletedProjectOnboarding === true);

  // 6d. Non-git cwd: claudeCliProjectKey degenerates to the plain resolved key (the CLI's own `?? cwd`
  // fallback) — same key ensureTrusted already uses for trust/MCP, so decline+trust land in ONE entry.
  const nonGitDir = path.join(root, "nongit-check");
  fs.mkdirSync(nonGitDir, { recursive: true });
  ownDirs.push(nonGitDir);
  check("non-git cwd → claudeCliProjectKey equals the plain resolved key",
    claudeCliProjectKey(nonGitDir) === keyFor(nonGitDir));

  // 6e. Git-root-resolver failure (a malformed worktree, an unreadable commondir, or anything else
  // escaping resolveGitMainCheckoutRootSync) must NEVER skip the protection — it falls back to the plain
  // cwd key and the decline is still written there.
  const fallbackDir = path.join(root, "fallback-dir");
  fs.mkdirSync(fallbackDir, { recursive: true });
  ownDirs.push(fallbackDir);
  __setGitMainCheckoutRootResolverForTest(() => { throw new Error("simulated resolver failure"); });
  try {
    ensureTrusted(fallbackDir);
    check("resolver failure → decline is still written, under the plain cwd key (never skipped)",
      declinedExternalImport(giJson, keyFor(fallbackDir)) && trusted(giJson, keyFor(fallbackDir)));
  } finally {
    __setGitMainCheckoutRootResolverForTest(); // restore the real resolver for any later test
  }

  // 6f. Card 17237fba, review Minor 2: a bare (or --separate-git-dir) repo's common git directory need
  // not be named ".git" at all. The installed CLI's own equivalent branch (decompiled bundle:
  // `he(c)!==".git" ? c : dirname(c)`) returns the common dir ITSELF in that case, never its parent —
  // confirmed with a real `git clone --bare` + `git worktree add` fixture below (git rev-parse
  // --git-common-dir for the worktree resolves to the bare repo dir, whose basename is "repo.git", not
  // ".git"). Loom's resolver used to unconditionally return the parent; this proves the fix.
  const bareRepo = path.join(root, "bare-repo.git");
  ownDirs.push(bareRepo);
  execSync(`git clone -q --bare "${giRepo}" "${bareRepo}"`);
  const bareWt = path.join(root, "bare-wt");
  ownDirs.push(bareWt);
  execSync(`git worktree add -q -b bare-wt-branch "${bareWt}" HEAD`, { cwd: bareRepo });
  const bareCommonDir = execSync(`git rev-parse --git-common-dir`, { cwd: bareWt }).toString().trim();
  check("bare-repo fixture: git itself reports a common dir whose basename is NOT \".git\"",
    path.basename(bareCommonDir) !== ".git");
  ensureTrusted(bareWt);
  check("bare/--separate-git-dir worktree → the import decline lands under the common dir ITSELF, not its parent",
    claudeCliProjectKey(bareWt) === keyFor(bareRepo) && declinedExternalImport(giJson, keyFor(bareRepo)));

  // 6g. Corrupt `.git` file: exists, but its content doesn't match the `gitdir: <path>` shape at all
  // (garbage, truncated, or just empty). Must fall back to the toplevel itself, never throw or skip.
  const corruptDir = path.join(root, "corrupt-gitfile");
  fs.mkdirSync(corruptDir, { recursive: true });
  ownDirs.push(corruptDir);
  fs.writeFileSync(path.join(corruptDir, ".git"), "not a real gitdir pointer\n");
  check("corrupt .git file (no gitdir: shape) → claudeCliProjectKey falls back to the toplevel itself",
    claudeCliProjectKey(corruptDir) === keyFor(corruptDir));
  ensureTrusted(corruptDir);
  check("corrupt .git file → ensureTrusted still writes the decline, under the toplevel key",
    declinedExternalImport(giJson, keyFor(corruptDir)));

  // 6h. Missing `commondir` file inside the private gitdir (the submodule shape — a submodule's own
  // private dir has no `commondir` file at all). Must fall back to the toplevel itself.
  const submoduleLikeDir = path.join(root, "submodule-like");
  fs.mkdirSync(submoduleLikeDir, { recursive: true });
  ownDirs.push(submoduleLikeDir);
  const privateDirNoCommondir = path.join(root, "submodule-like-private");
  fs.mkdirSync(privateDirNoCommondir, { recursive: true }); // deliberately no "commondir" file inside
  fs.writeFileSync(path.join(submoduleLikeDir, ".git"), `gitdir: ${privateDirNoCommondir}\n`);
  check("missing commondir file (submodule shape) → claudeCliProjectKey falls back to the toplevel itself",
    claudeCliProjectKey(submoduleLikeDir) === keyFor(submoduleLikeDir));

  // 6i. Relative gitdir pointer (the shape `git worktree add --relative-paths` would write — not
  // producible with the git version installed on this host, so simulated by rewriting a REAL worktree's
  // `.git` file to use a relative path instead of the absolute one git wrote). The resolver must still
  // land on the correct main checkout: it already resolves via `path.resolve(toplevel, …)`, never assumes
  // an absolute pointer.
  const giWtRel = path.join(root, "gitrepo-wt-rel");
  ownDirs.push(giWtRel);
  execSync(`git worktree add -q -b e789-wt-rel "${giWtRel}" HEAD`, { cwd: giRepo });
  const giWtRelGitFile = path.join(giWtRel, ".git");
  const absGitFileContents = fs.readFileSync(giWtRelGitFile, "utf8");
  const absPrivateDir = absGitFileContents.trim().replace(/^gitdir:\s*/, "");
  const relPrivateDir = path.relative(giWtRel, absPrivateDir).replace(/\\/g, "/");
  // Windows marks a worktree's `.git` file HIDDEN; an in-place writeFileSync (truncate+rewrite) on it
  // throws EPERM — same reason writeJsonAtomic (claude-config.ts) always replaces via temp+rename rather
  // than writing in place. Mirror that here instead of writing the file directly.
  const giWtRelGitFileTmp = `${giWtRelGitFile}.rel-test.tmp`;
  fs.writeFileSync(giWtRelGitFileTmp, `gitdir: ${relPrivateDir}\n`);
  fs.renameSync(giWtRelGitFileTmp, giWtRelGitFile);
  check("relative gitdir pointer (--relative-paths shape) → still resolves to the main checkout's key",
    claudeCliProjectKey(giWtRel) === giMainKey);

  // 6j. The main checkout root itself, AND a subdirectory of it with no `.git` of its own, both converge
  // on the SAME canonical key for the import decline — using a FRESH repo so this doesn't inherit giJson's
  // accumulated state from the scenarios above. Calling ensureTrusted directly on the main checkout root
  // (key === canonicalKey there) lands trust + decline in ONE entry; a sibling subdirectory resolves its
  // OWN canonical key to that same toplevel entry.
  const convergeRepo = path.join(root, "converge-repo");
  fs.mkdirSync(convergeRepo, { recursive: true });
  ownDirs.push(convergeRepo);
  execSync(`git init -q && git config user.email c@c && git config user.name c && git commit -q -m init --allow-empty`, { cwd: convergeRepo });
  const convergeSubdir = path.join(convergeRepo, "sub", "dir");
  fs.mkdirSync(convergeSubdir, { recursive: true });
  check("main checkout's own subdir → claudeCliProjectKey resolves UP to the same toplevel key",
    claudeCliProjectKey(convergeSubdir) === keyFor(convergeRepo));
  ensureTrusted(convergeRepo);
  check("main checkout itself → trust + decline land in ONE entry (key === canonicalKey)",
    trusted(giJson, keyFor(convergeRepo)) && declinedExternalImport(giJson, keyFor(convergeRepo)));
  // The subdir's OWN trust key is still unkeyed (trust/MCP keying is per-cwd, unchanged by this card) —
  // its call still writes trust under its own key, but must NOT re-touch or duplicate the decline already
  // settled on the shared canonical entry above.
  const convergeMainEntryBefore = JSON.stringify(entryFor(giJson, keyFor(convergeRepo)));
  ensureTrusted(convergeSubdir);
  check("a subdir of the same repo → gets its OWN trust entry (per-cwd keying, unchanged by this card)",
    trusted(giJson, keyFor(convergeSubdir)));
  check("a subdir of the same repo → does NOT also carry the import flags (those stay on the shared canonical entry)",
    !("hasClaudeMdExternalIncludesWarningShown" in (entryFor(giJson, keyFor(convergeSubdir)) ?? {})));
  check("a subdir of the same repo → the shared canonical (main-checkout) entry is left byte-unchanged",
    JSON.stringify(entryFor(giJson, keyFor(convergeRepo))) === convergeMainEntryBefore);
} finally {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
}

// === 3. The test never wrote any of ITS OWN entries into the real ~/.claude.json. ===
// Scoped to `ownDirs` rather than a whole-file diff (card ccd6153c) — see the comment at `ownDirs`'
// declaration above for why a before/after byte census of this shared, host-wide file is falsifiable
// by unrelated, concurrent, legitimate Loom activity and must not be used here.
const realCfg = fs.existsSync(realJson) ? JSON.parse(fs.readFileSync(realJson, "utf8")) : null;
const leaked = ownDirs.map(keyFor).filter((key) => realCfg?.projects && key in realCfg.projects);
check("real ~/.claude.json gained none of this test's own project entries", leaked.length === 0);

console.log(failures === 0
  ? "\nALL PASS — ensureTrusted honors CLAUDE_CONFIG_DIR and never touches the real ~/.claude.json."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
