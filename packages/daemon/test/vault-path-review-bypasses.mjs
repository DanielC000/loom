import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Three review passes on card 5ba4412d's containment fix, all reproduced on Windows: round 1 (Code
// Review of 7074e9f7, reviewer 62836c16, 4 blocking bypasses — PART A-E), round 2 (delta review of
// cf738124, reviewer e65cf525, 3 more bypasses — PART A5/A6/F), round 3 (delta review of ff1276d0,
// reviewer 140a0f51 — a test-coverage gap + 2 more real bugs — PART A7-A9/G/H). HERMETIC + CLAUDE-FREE +
// NETWORK-FREE, modeled on vault-path-repo-containment.mjs. See the decision record
// (docs/decisions/5ba4412d-vaultpath-governed-by-repo-containment.md) for the full incident history.
//
// Proves the DoD:
//   PART A — round-1 finding 1 + round-2 findings 1-2 + round-3 path-form coverage, SPELLING bypasses of
//            the containment predicate: (A1-A3) a directory JUNCTION, an 8.3 SHORT NAME, and the safe
//            `\\?\<drive>:\` prefix, each with a missing tail (`<spelling>\docs`, docs not yet created);
//            (A4) a plain UNC admin-share path refused outright; (A5, CRITICAL) the EXTENDED-LENGTH UNC
//            spelling (`\\?\UNC\host\share\...`) — the round-2 refusal wrongly exempted EVERY
//            `\\?\...`-prefixed path as "the safe local form," which let this one slip past containment
//            and create a real dir INSIDE the repo; (A6, CRITICAL, win32-only) a vaultPath spelled
//            `<repoPath>.` (a literal trailing dot) — Win32's own CreateFile-family APIs strip that
//            trailing dot resolving a spawned child's cwd, so the vault auto-committer's own `git` would
//            actually run inside the REAL repo even though `fs.realpathSync.native` treats the dotted and
//            undotted forms as distinct, nonexistent paths; (A7) the DOS device namespace form
//            (`\\.\<drive>:\...`); (A8) the NT native namespace prefix (`\??\<drive>:\...`); (A9) the
//            forward-slash spelling of the safe local form (`//?/<drive>:/...`) — regression, NOT refused.
//   PART B — round-1 finding 2: a `repos`-only PATCH (repoPath/vaultPath both omitted) whose NEW entry
//            CONTAINS the project's existing, UNCHANGED vaultPath.
//   PART C — round-1 finding 3: (C1) a `repoPath`-only rebind (vaultPath omitted) that strands the
//            existing, UNCHANGED vaultPath inside/around the NEW repoPath; (C2) vaultPath-inside-a-brand-
//            new-repos-entry, with that SAME entry supplied on the SAME call.
//   PART D — round-1 finding 4: a vault-only CREATE (no repoPath given) whose `repos` entry is nested
//            inside (or contains) its own vaultPath — never checked at all on the vault-only branch before.
//   PART E — round-1 minor 5 regression: the legacy-pairing exemption must NOT survive a call that leaves
//            repoPath FIXED while moving vaultPath into a subfolder of it (or its parent) — even for a
//            project that was already paired before this call.
//   PART F — round-2 finding 3 (MAJOR): POST /api/setup/project-init accepted a `repos` entry CONTAINING
//            the fresh bootstrapped project dir, validated with validateRepoRegistry alone (exact alias
//            only) — it never ran the shared containment check at all; (F1★) round-3 fix: validation now
//            runs BEFORE bootstrapProjectDir, so a refused init leaves no stray directory on disk.
//   PART G — round-3 finding 1 (test gap): canonicallyPaired's 4 call sites (REST PATCH, manager, setup,
//            platform) had zero coverage. A case-/trailing-slash-variant pre-patch pairing must keep its
//            exemption (G1-G5, one full + three light-coverage call sites); an UNSAFE pairing (UNC,
//            trailing-dot) must never be treated as exempt, even when string-identical (G6, direct).
//   PART H — round-3 finding 2: checkVaultPathUpdate's vault-only UNBIND guard still used a raw `===`,
//            so a case-/trailing-slash-variant-stored vault-only pairing's unbind was wrongly ALLOWED,
//            stranding the project (reproduced by the reviewer).
//
// Run: 1) build (turbo builds shared first), 2) node test/vault-path-review-bypasses.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const skip = (label, reason) => console.log(`SKIP  ${label} (${reason}) — not a failure`);

const tmpHome = path.join(os.tmpdir(), `loom-vaultpath-bypass-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";
import { commitAll } from "./_git-commit.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { canonicallyPaired } = await import("../dist/projects/vault-path.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const mkRepoWithParent = (tag) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `loom-vaultpath-bypass-parent-${tag}-`));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", "-c user.email=r@loom -c user.name=r");
  return { repo, parent };
};

/** Best-effort 8.3 short name lookup via `dir /x` — returns null (never throws) if unavailable (8dot3 name
 *  creation can be disabled host-wide, `fsutil 8dot3name query`), so a caller can SKIP rather than
 *  false-fail. Locale-independent: matches on the long name itself, not on any localized "<DIR>" label. */
function getShortName(parentDir, longName) {
  try {
    const out = execSync(`cmd /c dir /x "${parentDir}"`, { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(longName)) continue;
      const trimmed = line.trim();
      const idx = trimmed.lastIndexOf(longName);
      const before = trimmed.slice(0, idx).trim();
      const tokens = before.split(/\s+/);
      const candidate = tokens[tokens.length - 1];
      if (candidate && candidate !== longName && /~/.test(candidate)) return candidate;
    }
  } catch { /* best-effort */ }
  return null;
}

const now = new Date().toISOString();
const cleanupDirs = [tmpHome];
const pty = { enqueueStdin: () => ({ delivered: false }) };

try {
  // =====================================================================================================
  // PART A — finding 1: spelling bypasses of the not-yet-existing-candidate canonicalization.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "spelling-a.db"));
    const svc = new SessionService(db, pty, new OrchestrationControl());

    // --- A1: a directory JUNCTION into the repo, missing-tail candidate (`<junction>\docs`). ---
    {
      const { repo, parent: repoParent } = mkRepoWithParent("junction");
      cleanupDirs.push(repoParent);
      const separateVault = path.join(tmpHome, "junction-vault");
      const junctionParent = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vaultpath-bypass-junction-parent-"));
      cleanupDirs.push(junctionParent);
      const junction = path.join(junctionParent, "link-to-repo");
      fs.symlinkSync(repo, junction, "junction");
      db.insertProject({ id: "pJunction", name: "Junction", repoPath: repo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
      db.insertAgent({ id: "aJunction", projectId: "pJunction", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
      db.insertSession({ id: "SJunction", projectId: "pJunction", agentId: "aJunction", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
      let err = null;
      try { await svc.updateProjectStructural("SJunction", "pJunction", { vaultPath: path.join(junction, "docs") }); }
      catch (e) { err = e instanceof Error ? e.message : String(e); }
      check("(A1) vaultPath = <junction-into-repo>\\docs (missing tail) → rejected", typeof err === "string" && /(inside the code repo|equals\/aliases)/.test(err));
    }

    // --- A2: an 8.3 SHORT NAME of the repo's PARENT (so the repo itself has a long, shortenable name),
    // missing-tail candidate. Skips gracefully if 8dot3 name generation is off on this host. ---
    {
      const longParent = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vaultpath-bypass-shortname-"));
      cleanupDirs.push(longParent);
      const longRepoName = "a-very-long-directory-name-for-the-83-short-name-test";
      const repo = path.join(longParent, longRepoName);
      fs.mkdirSync(repo);
      fs.writeFileSync(path.join(repo, "README.md"), "# shortname\n");
      execSync("git init -q", { cwd: repo });
      commitAll(repo, "init", "-c user.email=r@loom -c user.name=r");
      const shortName = getShortName(longParent, longRepoName);
      if (!shortName) {
        skip("(A2) 8.3 short-name missing-tail bypass", "host has no discoverable 8.3 short name (8dot3 generation may be disabled)");
      } else {
        const shortRepoPath = path.join(longParent, shortName);
        const separateVault = path.join(tmpHome, "shortname-vault");
        db.insertProject({ id: "pShortName", name: "ShortName", repoPath: repo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
        db.insertAgent({ id: "aShortName", projectId: "pShortName", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
        db.insertSession({ id: "SShortName", projectId: "pShortName", agentId: "aShortName", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
        let err = null;
        try { await svc.updateProjectStructural("SShortName", "pShortName", { vaultPath: path.join(shortRepoPath, "docs") }); }
        catch (e) { err = e instanceof Error ? e.message : String(e); }
        check("(A2) vaultPath = <repo-8.3-short-name>\\docs (missing tail) → rejected", typeof err === "string" && /(inside the code repo|equals\/aliases)/.test(err));
      }
    }

    // --- A3: the `\\?\` extended-length prefix, missing-tail candidate. ---
    {
      const { repo, parent: repoParent } = mkRepoWithParent("extended");
      cleanupDirs.push(repoParent);
      const separateVault = path.join(tmpHome, "extended-vault");
      db.insertProject({ id: "pExtended", name: "Extended", repoPath: repo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
      db.insertAgent({ id: "aExtended", projectId: "pExtended", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
      db.insertSession({ id: "SExtended", projectId: "pExtended", agentId: "aExtended", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
      const extendedCandidate = path.join("\\\\?\\" + repo, "docs");
      let err = null;
      try { await svc.updateProjectStructural("SExtended", "pExtended", { vaultPath: extendedCandidate }); }
      catch (e) { err = e instanceof Error ? e.message : String(e); }
      check("(A3) vaultPath = \\\\?\\<repoPath>\\docs (missing tail) → rejected", typeof err === "string" && /(inside the code repo|equals\/aliases)/.test(err));
    }

    // --- A4: the UNC admin-share loopback alias (`\\localhost\c$\...`) — REFUSED outright (cannot be
    // safely canonicalized: realpathSync.native does NOT collapse this to its drive-letter equivalent). ---
    {
      const { repo, parent: repoParent } = mkRepoWithParent("unc");
      cleanupDirs.push(repoParent);
      const separateVault = path.join(tmpHome, "unc-vault");
      db.insertProject({ id: "pUnc", name: "Unc", repoPath: repo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
      db.insertAgent({ id: "aUnc", projectId: "pUnc", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
      db.insertSession({ id: "SUnc", projectId: "pUnc", agentId: "aUnc", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
      const drive = repo.match(/^([A-Za-z]):(.*)$/);
      if (!drive) {
        skip("(A4) UNC admin-share refusal", "repo path is not drive-letter-rooted");
      } else {
        const uncCandidate = `\\\\localhost\\${drive[1]}$${drive[2]}\\docs`;
        let err = null;
        try { await svc.updateProjectStructural("SUnc", "pUnc", { vaultPath: uncCandidate }); }
        catch (e) { err = e instanceof Error ? e.message : String(e); }
        check("(A4) vaultPath spelled as a UNC admin-share path → refused (cannot safely compare)", typeof err === "string" && /network\/device form/.test(err));
      }
    }

    // --- A5 (delta review finding 1, CRITICAL): the EXTENDED-LENGTH spelling of a UNC path
    // (`\\?\UNC\host\share\...`) — the round-2 refusal exempted EVERY `\\?\...`-prefixed path as "the safe
    // local form," which wrongly let this one through too (it is a UNC NETWORK path, not a local drive). ---
    {
      const { repo, parent: repoParent } = mkRepoWithParent("unc-extended");
      cleanupDirs.push(repoParent);
      const separateVault = path.join(tmpHome, "unc-extended-vault");
      db.insertProject({ id: "pUncExtended", name: "UncExtended", repoPath: repo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
      db.insertAgent({ id: "aUncExtended", projectId: "pUncExtended", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
      db.insertSession({ id: "SUncExtended", projectId: "pUncExtended", agentId: "aUncExtended", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
      const drive = repo.match(/^([A-Za-z]):(.*)$/);
      if (!drive) {
        skip("(A5) extended-UNC refusal", "repo path is not drive-letter-rooted");
      } else {
        const uncExtendedCandidate = `\\\\?\\UNC\\localhost\\${drive[1]}$${drive[2]}\\docsC`;
        let err = null;
        try { await svc.updateProjectStructural("SUncExtended", "pUncExtended", { vaultPath: uncExtendedCandidate }); }
        catch (e) { err = e instanceof Error ? e.message : String(e); }
        check("(A5) vaultPath spelled as \\\\?\\UNC\\...\\docsC → refused (not the safe local \\\\?\\<drive>: form)", typeof err === "string" && /network\/device form/.test(err));
      }
    }

    // --- A6 (delta review finding 2, CRITICAL): a vaultPath spelled as `<repoPath>.` (a literal trailing
    // dot). The dotted form does not exist on disk, so the deepest-existing-ancestor walk would otherwise
    // find the REPO itself and rejoin the dotted tail VERBATIM — Win32's own CreateFile-family APIs
    // silently strip that trailing dot when resolving a spawned child's cwd, so the vault auto-committer's
    // own `git`, given this vaultPath, would actually run INSIDE the real repo. win32-only (POSIX has no
    // such stripping — a trailing '.' there is an ordinary filename character). ---
    if (process.platform === "win32") {
      const { repo, parent: repoParent } = mkRepoWithParent("trailing-dot");
      cleanupDirs.push(repoParent);
      const separateVault = path.join(tmpHome, "trailing-dot-vault");
      db.insertProject({ id: "pTrailingDot", name: "TrailingDot", repoPath: repo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
      db.insertAgent({ id: "aTrailingDot", projectId: "pTrailingDot", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
      db.insertSession({ id: "STrailingDot", projectId: "pTrailingDot", agentId: "aTrailingDot", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
      const trailingDotCandidate = `${repo}.`;
      let err = null;
      try { await svc.updateProjectStructural("STrailingDot", "pTrailingDot", { vaultPath: trailingDotCandidate }); }
      catch (e) { err = e instanceof Error ? e.message : String(e); }
      check("(A6) vaultPath = <repoPath>. (trailing dot) → refused", typeof err === "string" && /ending in '\.' or ' '/.test(err));
    } else {
      skip("(A6) trailing-dot refusal", "win32-only check");
    }

    // --- A7 (round-3 review request): the DOS device namespace form (`\\.\<drive>:\...`) — refused
    // outright, same family as the UNC forms above. ---
    {
      const { repo, parent: repoParent } = mkRepoWithParent("dos-device");
      cleanupDirs.push(repoParent);
      const separateVault = path.join(tmpHome, "dos-device-vault");
      db.insertProject({ id: "pDosDevice", name: "DosDevice", repoPath: repo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
      db.insertAgent({ id: "aDosDevice", projectId: "pDosDevice", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
      db.insertSession({ id: "SDosDevice", projectId: "pDosDevice", agentId: "aDosDevice", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
      const drive = repo.match(/^([A-Za-z]):(.*)$/);
      if (!drive) {
        skip("(A7) DOS device namespace refusal", "repo path is not drive-letter-rooted");
      } else {
        const dosDeviceCandidate = `\\\\.\\${drive[1]}:${drive[2]}\\docs`;
        let err = null;
        try { await svc.updateProjectStructural("SDosDevice", "pDosDevice", { vaultPath: dosDeviceCandidate }); }
        catch (e) { err = e instanceof Error ? e.message : String(e); }
        check("(A7) vaultPath spelled as \\\\.\\<drive>:\\...\\docs (DOS device form) → refused", typeof err === "string" && /network\/device form/.test(err));
      }
    }

    // --- A8 (round-3 review request): the NT native namespace prefix (`\??\<drive>:\...`) — refused
    // outright. ---
    {
      const { repo, parent: repoParent } = mkRepoWithParent("nt-native");
      cleanupDirs.push(repoParent);
      const separateVault = path.join(tmpHome, "nt-native-vault");
      db.insertProject({ id: "pNtNative", name: "NtNative", repoPath: repo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
      db.insertAgent({ id: "aNtNative", projectId: "pNtNative", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
      db.insertSession({ id: "SNtNative", projectId: "pNtNative", agentId: "aNtNative", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
      const drive = repo.match(/^([A-Za-z]):(.*)$/);
      if (!drive) {
        skip("(A8) NT native namespace refusal", "repo path is not drive-letter-rooted");
      } else {
        const ntNativeCandidate = `\\??\\${drive[1]}:${drive[2]}\\docs`;
        let err = null;
        try { await svc.updateProjectStructural("SNtNative", "pNtNative", { vaultPath: ntNativeCandidate }); }
        catch (e) { err = e instanceof Error ? e.message : String(e); }
        check("(A8) vaultPath spelled as \\??\\<drive>:\\...\\docs (NT native namespace) → refused", typeof err === "string" && /network\/device form/.test(err));
      }
    }

    // --- A9 (round-3 review request): the FORWARD-SLASH spelling of the safe extended-length local form
    // (`//?/<drive>:/...`) — regression: this one is NOT refused, and still correctly resolves through
    // containment exactly like A3's backslash form (`\\?\<drive>:\...`). ---
    {
      const { repo, parent: repoParent } = mkRepoWithParent("fwdslash-extended");
      cleanupDirs.push(repoParent);
      const separateVault = path.join(tmpHome, "fwdslash-extended-vault");
      db.insertProject({ id: "pFwdSlash", name: "FwdSlash", repoPath: repo, vaultPath: separateVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
      db.insertAgent({ id: "aFwdSlash", projectId: "pFwdSlash", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
      db.insertSession({ id: "SFwdSlash", projectId: "pFwdSlash", agentId: "aFwdSlash", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
      const fwdSlashCandidate = path.join("//?/" + repo, "docs");
      let err = null;
      try { await svc.updateProjectStructural("SFwdSlash", "pFwdSlash", { vaultPath: fwdSlashCandidate }); }
      catch (e) { err = e instanceof Error ? e.message : String(e); }
      check("(A9) vaultPath = //?/<repoPath>/docs (forward-slash safe form) → still correctly rejected as containment, NOT refused as unsafe", typeof err === "string" && /is inside the code repo at/.test(err));
    }

    db.close();
  }

  // =====================================================================================================
  // PART B — finding 2: a `repos`-only PATCH (repoPath/vaultPath both omitted) whose NEW entry CONTAINS
  // the project's existing, UNCHANGED vaultPath.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "repos-only.db"));
    const { repo: codeRepo, parent: codeRepoParent } = mkRepoWithParent("repos-only-primary");
    cleanupDirs.push(codeRepoParent);
    // The registry entry's real repo CONTAINS the project's vaultPath.
    const registryRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vaultpath-bypass-reposonly-registry-"));
    cleanupDirs.push(registryRepoDir);
    fs.writeFileSync(path.join(registryRepoDir, "README.md"), "# registry\n");
    execSync("git init -q", { cwd: registryRepoDir });
    commitAll(registryRepoDir, "init", "-c user.email=r@loom -c user.name=r");
    const vaultInsideRegistry = path.join(registryRepoDir, "vault-subdir");
    fs.mkdirSync(vaultInsideRegistry);
    db.insertProject({ id: "pReposOnly", name: "ReposOnly", repoPath: codeRepo, vaultPath: vaultInsideRegistry, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });

    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      const b1 = await app.inject({
        method: "PATCH", url: "/api/projects/pReposOnly",
        payload: { repos: [{ key: "registry", path: registryRepoDir }] },
      });
      check("(B1) repos-only PATCH whose new entry CONTAINS the existing vaultPath → 400", b1.statusCode === 400);
      check("(B1) error names the containment refusal", /would contain the code repo at|is inside the code repo at/.test(b1.json().error ?? ""));
      check("(B1) registry UNCHANGED after rejection", db.getProject("pReposOnly")?.repos?.length === 0);
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART C — finding 3.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "repopath-only.db"));
    const { repo: oldRepo, parent: oldRepoParent } = mkRepoWithParent("repopath-only-old");
    cleanupDirs.push(oldRepoParent);
    const { repo: newRepo, parent: newRepoParent } = mkRepoWithParent("repopath-only-new");
    cleanupDirs.push(newRepoParent);
    // The project's EXISTING vaultPath sits inside newRepo — safe today (repoPath is oldRepo), but would
    // be stranded the moment repoPath rebinds to newRepo without vaultPath itself ever being touched.
    const strandedVault = path.join(newRepo, "vault-subdir");
    fs.mkdirSync(strandedVault);
    db.insertProject({ id: "pRepoPathOnly", name: "RepoPathOnly", repoPath: oldRepo, vaultPath: strandedVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });

    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      // (C1) repoPath-only rebind (vaultPath omitted) that strands the UNCHANGED vaultPath inside the NEW
      // repoPath.
      const c1 = await app.inject({ method: "PATCH", url: "/api/projects/pRepoPathOnly", payload: { repoPath: newRepo } });
      check("(C1) repoPath-only rebind that strands the existing vaultPath inside the NEW repoPath → 400", c1.statusCode === 400);
      check("(C1) error names the containment refusal", /is inside the code repo at/.test(c1.json().error ?? ""));
      check("(C1) repoPath UNCHANGED after rejection", db.getProject("pRepoPathOnly")?.repoPath === oldRepo);

      // (C2) vaultPath-inside-a-brand-new-repos-entry, with that SAME entry supplied on the SAME call.
      const { repo: freshRepo, parent: freshRepoParent } = mkRepoWithParent("repopath-only-fresh");
      cleanupDirs.push(freshRepoParent);
      const freshVault = path.join(tmpHome, "repopath-only-fresh-vault");
      db.insertProject({ id: "pSameCall", name: "SameCall", repoPath: oldRepo, vaultPath: freshVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
      const c2 = await app.inject({
        method: "PATCH", url: "/api/projects/pSameCall",
        payload: { vaultPath: path.join(freshRepo, "vault-subdir"), repos: [{ key: "fresh", path: freshRepo }] },
      });
      check("(C2) {vaultPath inside a NEW repos entry, repos:[that entry]} in ONE call → 400", c2.statusCode === 400);
      check("(C2) error names the containment refusal", /is inside the code repo at/.test(c2.json().error ?? ""));
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART D — finding 4: a vault-only CREATE whose `repos` entry is nested inside (or contains) its own
  // vaultPath — never checked at all on the vault-only branch before.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "vault-only-repos.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      const vaultOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vaultpath-bypass-vaultonly-"));
      cleanupDirs.push(vaultOnlyDir);
      const { repo: nestedRepo } = mkRepoWithParent("vault-only-nested");
      // Move the nested repo INSIDE the vault-only dir instead of using its own parent — simplest way to
      // get a real git repo textually nested under vaultOnlyDir.
      const nestedInsideVault = path.join(vaultOnlyDir, "nested-repo");
      fs.renameSync(nestedRepo, nestedInsideVault);

      const d1 = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "VaultOnlyWithNestedRepos", vaultPath: vaultOnlyDir, repos: [{ key: "nested", path: nestedInsideVault }] },
      });
      check("(D1) vault-only create with a `repos` entry NESTED INSIDE vaultPath → 400", d1.statusCode === 400);
      check("(D1) error names the containment refusal", /would contain the code repo at/.test(d1.json().error ?? ""));
      check("(D1) no project row was created on rejection", db.listAllProjects().length === 0);

      // (D2) regression: a vault-only create with NO repos conflict still succeeds.
      const cleanVaultOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vaultpath-bypass-vaultonly-clean-"));
      cleanupDirs.push(cleanVaultOnlyDir);
      const d2 = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "VaultOnlyClean", vaultPath: cleanVaultOnlyDir } });
      check("(D2) vault-only create with no repos conflict → 201 (regression)", d2.statusCode === 201);
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART E — minor 5 regression: the legacy-pairing exemption must NOT survive a call that leaves repoPath
  // FIXED while moving vaultPath into a subfolder of it (or its parent) — even for an ALREADY-paired
  // project.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "legacy-pairing.db"));
    const svc = new SessionService(db, pty, new OrchestrationControl());
    // A LEGACY pairing where repoPath IS a real git repo (the pre-cdc3792d default-vaultPath-to-repoPath
    // shape) — repoPath === vaultPath, and repoPath is genuinely a git repo (unlike a true vault-only row).
    const { repo: legacyRepo, parent: legacyRepoParent } = mkRepoWithParent("legacy-pairing");
    cleanupDirs.push(legacyRepoParent);
    db.insertProject({ id: "pLegacy", name: "Legacy", repoPath: legacyRepo, vaultPath: legacyRepo, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
    db.insertAgent({ id: "aLegacy", projectId: "pLegacy", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
    db.insertSession({ id: "SLegacy", projectId: "pLegacy", agentId: "aLegacy", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });

    // (E1) move vaultPath to a SUBFOLDER of the still-real, still-unchanged repoPath → rejected, even
    // though this project was ALREADY paired before this call.
    let e1Err = null;
    try { await svc.updateProjectStructural("SLegacy", "pLegacy", { vaultPath: path.join(legacyRepo, "docs") }); }
    catch (e) { e1Err = e instanceof Error ? e.message : String(e); }
    check("(E1) legacy-paired project moving vaultPath to a SUBFOLDER of its own still-real repoPath → rejected", typeof e1Err === "string" && /is inside the code repo at/.test(e1Err));
    check("(E1) rejected move left vaultPath UNCHANGED", db.getProject("pLegacy")?.vaultPath === legacyRepo);

    // (E2) move vaultPath to the PARENT of the still-real, still-unchanged repoPath → also rejected.
    let e2Err = null;
    try { await svc.updateProjectStructural("SLegacy", "pLegacy", { vaultPath: legacyRepoParent }); }
    catch (e) { e2Err = e instanceof Error ? e.message : String(e); }
    check("(E2) legacy-paired project moving vaultPath to the PARENT of its own still-real repoPath → rejected", typeof e2Err === "string" && /would contain the code repo at/.test(e2Err));

    // (E3) regression: re-asserting the SAME shared location still succeeds (the legitimate no-op case).
    const e3 = await svc.updateProjectStructural("SLegacy", "pLegacy", { vaultPath: legacyRepo });
    check("(E3) legacy-paired project re-asserting the SAME shared location → succeeds (regression)", !e3.error && e3.vaultPath === legacyRepo);

    db.close();
  }

  // =====================================================================================================
  // PART F — delta review finding 3 (MAJOR): POST /api/setup/project-init accepted a `repos` entry
  // CONTAINING (or contained by) the fresh bootstrapped project dir without ever running the shared
  // containment check — it validated `repos` with validateRepoRegistry alone (exact alias only). An
  // explicit `dirName` makes the bootstrapped dir's path predictable; pre-making WORKSPACE_ROOT itself
  // into a real git repo G reproduces the review's own repro shape ("LOOM_HOME inside a git repo G") one
  // level down (WORKSPACE_ROOT is always `<LOOM_HOME>/workspaces`): the fresh `kind:"vault"` project ends
  // up nested INSIDE G, and `repos:[G]` names G as a registered repo.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "project-init-triple.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      const workspaceRoot = path.join(tmpHome, "workspaces");
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# workspace root as a repo\n");
      execSync("git init -q", { cwd: workspaceRoot });
      commitAll(workspaceRoot, "init", "-c user.email=r@loom -c user.name=r");

      // (F1) kind:"vault" project-init with a repos entry CONTAINING the fresh bootstrapped dir -> 400.
      const f1 = await app.inject({
        method: "POST", url: "/api/setup/project-init",
        payload: { name: "NestedVaultInit", kind: "vault", dirName: "nested-vault-project", repos: [{ key: "root", path: workspaceRoot }] },
      });
      check("(F1) project-init kind:vault with a repos entry CONTAINING the fresh bootstrapped dir → 400", f1.statusCode === 400);
      check("(F1) error names the containment refusal", /would contain the code repo at|is inside the code repo at/.test(f1.json().error ?? ""));
      check("(F1) no project row was created on rejection", !db.listAllProjects().some((p) => p.name === "NestedVaultInit"));
      // (F1★) round-3 fix: validation now runs BEFORE bootstrapProjectDir, so a refused init must leave
      // NO stray directory on disk at all (previously it validated AFTER bootstrapping).
      check("(F1★) the rejected init left NO stray directory on disk", !fs.existsSync(path.join(workspaceRoot, "nested-vault-project")));

      // (F2) regression: a project-init with no containment conflict still succeeds.
      const f2 = await app.inject({
        method: "POST", url: "/api/setup/project-init",
        payload: { name: "CleanVaultInit", kind: "vault", dirName: "clean-vault-project" },
      });
      check("(F2) project-init kind:vault with no repos conflict → 201 (regression)", f2.statusCode === 201);
      check("(F2) the accepted init DID create its directory", fs.existsSync(path.join(workspaceRoot, "clean-vault-project")));
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART G — round-3 review finding 1 (test gap): canonicallyPaired's 4 call sites (REST PATCH, manager,
  // setup, platform) had ZERO coverage — reverting any one of them to a raw `project.repoPath ===
  // project.vaultPath` comparison passed the full suite. A case- or trailing-slash-DIFFERENT pre-patch
  // pairing is the SAME real directory and must keep its legacy-pairing exemption; an UNSAFE pairing (a
  // UNC form, a trailing-dot form) must never be treated as exempt, even when string-identical.
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "canonically-paired.db"));
    const svc = new SessionService(db, pty, new OrchestrationControl());
    const caseFlip = (p) => {
      const c = p.charAt(0);
      return (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + p.slice(1);
    };

    // --- G1/G2 (manager, full coverage): a case-variant / trailing-slash-variant pre-patch pairing keeps
    // its exemption on a reassert-to-canonical-form patch. ---
    {
      const { repo: legacyRepo } = mkRepoWithParent("canon-paired-case");
      const caseVariantVault = caseFlip(legacyRepo);
      db.insertProject({ id: "pCanonCase", name: "CanonCase", repoPath: legacyRepo, vaultPath: caseVariantVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
      db.insertAgent({ id: "aCanonCase", projectId: "pCanonCase", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
      db.insertSession({ id: "SCanonCase", projectId: "pCanonCase", agentId: "aCanonCase", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
      if (caseVariantVault === legacyRepo) {
        skip("(G1) case-variant pairing exemption", "repo path has no case-flippable leading character");
      } else {
        const g1 = await svc.updateProjectStructural("SCanonCase", "pCanonCase", { vaultPath: legacyRepo });
        check("(G1) a case-variant pre-patch pairing keeps its exemption on reassert → succeeds", !g1.error && g1.vaultPath === legacyRepo);
      }
    }
    {
      const { repo: legacyRepo } = mkRepoWithParent("canon-paired-slash");
      const slashVariantVault = legacyRepo + path.sep;
      db.insertProject({ id: "pCanonSlash", name: "CanonSlash", repoPath: legacyRepo, vaultPath: slashVariantVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
      db.insertAgent({ id: "aCanonSlash", projectId: "pCanonSlash", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
      db.insertSession({ id: "SCanonSlash", projectId: "pCanonSlash", agentId: "aCanonSlash", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
      const g2 = await svc.updateProjectStructural("SCanonSlash", "pCanonSlash", { vaultPath: legacyRepo });
      check("(G2) a trailing-slash-variant pre-patch pairing keeps its exemption on reassert → succeeds", !g2.error && g2.vaultPath === legacyRepo);
    }

    // --- G3 (setup, light coverage): same shape, trailing-slash variant. ---
    {
      const { repo: legacyRepo } = mkRepoWithParent("canon-paired-setup");
      const slashVariantVault = legacyRepo + path.sep;
      db.insertProject({ id: "pCanonSetup", name: "CanonSetup", repoPath: legacyRepo, vaultPath: slashVariantVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
      class SeamHost extends createSeamHost(PtyHost) { stop() {} }
      const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
      const host = new SeamHost(events);
      const setupSvc = new SessionService(db, host, new OrchestrationControl());
      const router = new SetupMcpRouter(db, setupSvc);
      const server = router.buildServer();
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "canon-paired-setup-test", version: "0" });
      await client.connect(clientT);
      const g3 = JSON.parse((await client.callTool({ name: "project_update", arguments: { projectId: "pCanonSetup", vaultPath: legacyRepo } })).content[0].text);
      check("(G3) setup project_update: a trailing-slash-variant pre-patch pairing keeps its exemption → succeeds", !g3.error && g3.vaultPath === legacyRepo);
      await client.close();
    }

    // --- G4 (platform, light coverage): same shape, trailing-slash variant. ---
    {
      const { repo: legacyRepo } = mkRepoWithParent("canon-paired-platform");
      const slashVariantVault = legacyRepo + path.sep;
      db.insertProject({ id: "pCanonPlatform", name: "CanonPlatform", repoPath: legacyRepo, vaultPath: slashVariantVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
      const router = new PlatformMcpRouter(db, svc);
      const server = router.buildServer();
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "canon-paired-platform-test", version: "0" });
      await client.connect(clientT);
      const g4 = JSON.parse((await client.callTool({ name: "project_update", arguments: { projectId: "pCanonPlatform", vaultPath: legacyRepo } })).content[0].text);
      check("(G4) platform project_update: a trailing-slash-variant pre-patch pairing keeps its exemption → succeeds", !g4.error && g4.vaultPath === legacyRepo);
      await client.close();
    }

    // --- G5 (REST PATCH, light coverage): same shape, trailing-slash variant. ---
    {
      const { repo: legacyRepo } = mkRepoWithParent("canon-paired-rest");
      const slashVariantVault = legacyRepo + path.sep;
      db.insertProject({ id: "pCanonRest", name: "CanonRest", repoPath: legacyRepo, vaultPath: slashVariantVault, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
      const stub = {};
      const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
      const g5 = await app.inject({ method: "PATCH", url: "/api/projects/pCanonRest", payload: { vaultPath: legacyRepo } });
      check("(G5) REST PATCH: a trailing-slash-variant pre-patch pairing keeps its exemption → 200", g5.statusCode === 200);
    }

    // --- G6: canonicallyPaired's OWN contract, tested directly (no HTTP/MCP indirection needed to pin
    // this specific behavior — a call site simply forwards its return value). ---
    {
      const { repo: realRepo, parent: realRepoParent } = mkRepoWithParent("canon-direct");
      const { repo: distinctRepo, parent: distinctRepoParent } = mkRepoWithParent("canon-direct-distinct");
      cleanupDirs.push(realRepoParent, distinctRepoParent);
      check("(G6) canonicallyPaired(real, real) → true", canonicallyPaired(realRepo, realRepo) === true);
      check("(G6) canonicallyPaired(real, caseVariant) → true", canonicallyPaired(realRepo, caseFlip(realRepo)) === true);
      check("(G6) canonicallyPaired(real, trailingSlashVariant) → true", canonicallyPaired(realRepo, realRepo + path.sep) === true);
      check("(G6) canonicallyPaired(real, distinctReal) → false", canonicallyPaired(realRepo, distinctRepo) === false);
      const drive = realRepo.match(/^([A-Za-z]):(.*)$/);
      if (drive) {
        const uncForm = `\\\\localhost\\${drive[1]}$${drive[2]}`;
        check("(G6) canonicallyPaired(uncForm, uncForm) → false (unsafe, even though string-identical)", canonicallyPaired(uncForm, uncForm) === false);
      } else {
        skip("(G6) UNC-pair unsafe-not-exempt check", "repo path is not drive-letter-rooted");
      }
      if (process.platform === "win32") {
        const dottedForm = `${realRepo}.`;
        check("(G6) canonicallyPaired(dottedForm, dottedForm) → false (unsafe, even though string-identical)", canonicallyPaired(dottedForm, dottedForm) === false);
      } else {
        skip("(G6) trailing-dot-pair unsafe-not-exempt check", "win32-only");
      }
    }

    db.close();
  }

  // =====================================================================================================
  // PART H — round-3 review finding 2: checkVaultPathUpdate's vault-only UNBIND guard still used a raw
  // `project.repoPath === project.vaultPath` — a case- or trailing-slash-DIFFERENT pre-patch pairing (the
  // SAME real, non-git vault-only folder) silently failed the "already paired" check, so an explicit
  // unbind was WRONGLY ALLOWED and stranded the vault-only project (reproduced by the reviewer).
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "unbind-canonical.db"));
    const svc = new SessionService(db, pty, new OrchestrationControl());
    const caseFlip = (p) => {
      const c = p.charAt(0);
      return (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + p.slice(1);
    };
    const vaultOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vaultpath-bypass-unbind-"));
    cleanupDirs.push(vaultOnlyDir);
    const variantVaultOnlyDir = caseFlip(vaultOnlyDir) !== vaultOnlyDir ? caseFlip(vaultOnlyDir) : vaultOnlyDir + path.sep;
    db.insertProject({ id: "pUnbindCanon", name: "UnbindCanon", repoPath: vaultOnlyDir, vaultPath: variantVaultOnlyDir, config: {}, createdAt: now, archivedAt: null, reserved: false, repos: [] });
    db.insertAgent({ id: "aUnbindCanon", projectId: "pUnbindCanon", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
    db.insertSession({ id: "SUnbindCanon", projectId: "pUnbindCanon", agentId: "aUnbindCanon", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });

    let h1Err = null;
    try { await svc.updateProjectStructural("SUnbindCanon", "pUnbindCanon", { vaultPath: "" }); }
    catch (e) { h1Err = e instanceof Error ? e.message : String(e); }
    check("(H1) unbinding a case/slash-variant-stored vault-only pairing → REJECTED (not stranded)", typeof h1Err === "string" && /vault-only project/.test(h1Err));
    check("(H1) rejected unbind left vaultPath UNCHANGED", db.getProject("pUnbindCanon")?.vaultPath === variantVaultOnlyDir);

    db.close();
  }
} finally {
  for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — round 1's 4 blocking bypasses, round 2's 3 further bypasses (extended-UNC spelling, trailing-dot alias, project-init's missing check), and round 3's gaps (DOS-device/NT-native-namespace refusal + forward-slash-safe-form regression, canonicallyPaired call-site coverage, the vault-only unbind guard's own raw-=== bug, and project-init now validating BEFORE bootstrapping) are all closed — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
