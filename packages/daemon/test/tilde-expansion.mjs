import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Linux onboarding gap (task 5dbdd963, owner-reported 2026-07-21): `~` is a SHELL expansion Node never
// sees, so a user-typed `~/projects/myrepo` reached isGitRepo/isExistingDir LITERALLY and failed. The fix
// is a shared `expandTilde` helper (paths.ts) applied at every user-supplied host-path input boundary —
// this test proves the helper's semantics AND that the boundaries actually call it.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE, modeled on project-rebind.mjs / reference-repos-rest.mjs: a
// sandboxed HOME/USERPROFILE so os.homedir() resolves to a temp dir we control, real temp git repos
// created UNDER that sandboxed home so a "~/…" path resolves to something real.
//
// Proves the DoD:
//   PART A — expandTilde unit semantics: "~" alone → homedir; "~/…"/"~\…" → homedir + rest;
//            "~otheruser/…" left UNCHANGED; a non-tilde path left UNCHANGED.
//   PART B — POST /api/projects: a "~/…" repoPath/vaultPath resolves + binds (201, stored path is the
//            EXPANDED absolute one, not the literal "~/…" string); a referenceRepos entry with "~/…"
//            resolves too.
//   PART C — PATCH /api/projects/:id: a "~/…" repoPath rebind + vaultPath both expand.
//   PART D — setup operator project_create (mcp/setup.ts): a "~/…" repoPath/vaultPath expands.
//
// Run: 1) build (turbo builds shared first), 2) node test/tilde-expansion.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import,
// and expandTilde reads os.homedir() — which itself reads HOME/USERPROFILE — at CALL time). ---
const tmpHome = path.join(os.tmpdir(), `loom-tilde-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45322";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { expandTilde } = await import("../dist/paths.js");
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- Real git repos created UNDER the sandboxed home, so a "~/…"-relative path resolves to something real. ---
const mkRepo = (relDir) => {
  const r = path.join(sandboxHome, relDir);
  fs.mkdirSync(r, { recursive: true });
  fs.writeFileSync(path.join(r, "README.md"), `# ${relDir}\n`);
  execSync(`git init -q && git add . && git -c user.email=r@loom -c user.name=r commit -q -m init`, { cwd: r });
  return r;
};
const primary = mkRepo("projects/myrepo");
const refRepo = mkRepo("projects/refrepo");

try {
  // =====================================================================================================
  // PART A — expandTilde unit semantics
  // =====================================================================================================
  {
    check("(A1) '~' alone → homedir", expandTilde("~") === os.homedir());
    check("(A2) '~/projects/myrepo' → homedir + rest", expandTilde("~/projects/myrepo") === path.join(os.homedir(), "projects/myrepo"));
    check("(A3) '~\\\\projects\\\\myrepo' (backslash form) → homedir + rest", expandTilde("~\\projects\\myrepo") === path.join(os.homedir(), "projects\\myrepo"));
    check("(A4) '~otheruser/foo' (another user's home) left UNCHANGED", expandTilde("~otheruser/foo") === "~otheruser/foo");
    check("(A5) a non-tilde absolute path left UNCHANGED", expandTilde(primary) === primary);
    check("(A6) a relative non-tilde path left UNCHANGED", expandTilde("some/relative/path") === "some/relative/path");
    check("(A7) '~/' (trailing slash, empty rest) → homedir", expandTilde("~/") === path.join(os.homedir(), ""));
  }

  // =====================================================================================================
  // PART B — POST /api/projects applies expandTilde to repoPath, vaultPath, referenceRepos[]
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "rest.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      const created = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "TildeProject", repoPath: "~/projects/myrepo", vaultPath: "~/projects/myrepo", referenceRepos: ["~/projects/refrepo"] },
      });
      check("(B1) POST with a '~/…' repoPath/vaultPath → 201 (not a 400 'not an existing git repository')", created.statusCode === 201);
      const p = created.json();
      check("(B1) stored repoPath is the EXPANDED absolute path", p.repoPath === primary);
      check("(B1) stored vaultPath is the EXPANDED absolute path", p.vaultPath === primary);
      check("(B1) stored referenceRepos entry is the EXPANDED absolute path", Array.isArray(p.referenceRepos) && p.referenceRepos[0] === refRepo);
      check("(B1) persisted to the Db (not just the response)", db.getProject(p.id)?.repoPath === primary && db.getProject(p.id)?.vaultPath === primary);

      // (B2) '~' alone (no rest) as repoPath resolves to the home dir itself — the home dir is a real
      // directory but NOT a git repo, so this should 400 on isGitRepo (proving expansion ran BEFORE the
      // git check, not that the literal string "~" was rejected for some other reason).
      const bareHome = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "BareHome", repoPath: "~", vaultPath: "~" },
      });
      check("(B2) bare '~' repoPath expands to homedir then fails isGitRepo (homedir isn't a repo) → 400", bareHome.statusCode === 400);
      check("(B2) error names the EXPANDED path, not the literal '~'", bareHome.json().error.includes(os.homedir()));

      // (B3) vault-optional (card cdc3792d, merged to main after this fix): a repo-only create with a
      // '~' repoPath and NO vaultPath at all must expand + 201 — proving the undefined-guard on the
      // create route's expandTilde calls (an unguarded expandTilde(undefined) would throw on .startsWith
      // and 500 instead of validating cleanly).
      const repoOnly = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "RepoOnlyTilde", repoPath: "~/projects/myrepo" },
      });
      check("(B3) repo-only create with a '~/…' repoPath and NO vaultPath → 201 (does not throw)", repoOnly.statusCode === 201);
      const p3 = repoOnly.json();
      check("(B3) stored repoPath is the EXPANDED absolute path", p3.repoPath === primary);
      check("(B3) vaultPath defaults to \"\" (never defaulted to repoPath)", p3.vaultPath === "");

      // (B4) vault-only create with a '~/…' vaultPath and NO repoPath must also expand + 201 — the other
      // undefined-guard direction (repoPath absent this time).
      const vaultOnly = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "VaultOnlyTilde", vaultPath: "~/projects/refrepo" },
      });
      check("(B4) vault-only create with a '~/…' vaultPath and NO repoPath → 201 (does not throw)", vaultOnly.statusCode === 201);
      const p4 = vaultOnly.json();
      check("(B4) stored repoPath/vaultPath both the EXPANDED absolute path", p4.repoPath === refRepo && p4.vaultPath === refRepo);
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART C — PATCH /api/projects/:id applies expandTilde to repoPath (rebind) + vaultPath
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "patch.db"));
    const now = new Date().toISOString();
    db.insertProject({ id: "pPatch", name: "PatchMe", repoPath: primary, vaultPath: primary, config: {}, createdAt: now, archivedAt: null, reserved: false, referenceRepos: [] });
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    try {
      const patched = await app.inject({
        method: "PATCH", url: "/api/projects/pPatch",
        payload: { repoPath: "~/projects/refrepo", vaultPath: "~/projects/refrepo" },
      });
      check("(C1) PATCH with a '~/…' repoPath/vaultPath → 200", patched.statusCode === 200);
      check("(C1) stored repoPath is the EXPANDED absolute path", db.getProject("pPatch")?.repoPath === refRepo);
      check("(C1) stored vaultPath is the EXPANDED absolute path", db.getProject("pPatch")?.vaultPath === refRepo);
    } finally {
      db.close();
    }
  }

  // =====================================================================================================
  // PART D — setup operator project_create (mcp/setup.ts) applies expandTilde
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "setup.db"));
    class SeamHost extends PtyHost {
      createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
      stop() {}
    }
    const events = { onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, busy) { db.setBusy(id, busy); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
    const host = new SeamHost(events);
    const svc = new SessionService(db, host, new OrchestrationControl());
    const router = new SetupMcpRouter(db, svc);
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "tilde-test", version: "0" });
    await client.connect(clientT);
    const parse = (res) => JSON.parse(res.content[0].text);

    const created = await parse(await client.callTool({ name: "project_create", arguments: { name: "SetupTilde", repoPath: "~/projects/myrepo", vaultPath: "~/projects/myrepo" } }));
    check("(D1) setup project_create with a '~/…' repoPath resolves (no error)", !created.error);
    check("(D1) stored repoPath is the EXPANDED absolute path", created.repoPath === primary);
    check("(D1) stored vaultPath is the EXPANDED absolute path", created.vaultPath === primary);
    check("(D1) persisted to the Db", db.getProject(created.id)?.repoPath === primary);

    await client.close();
    db.close();
  }
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — expandTilde correctly resolves '~'/'~/…' to the home dir (leaving '~otheruser/…' and non-tilde paths unchanged), and every user-supplied host-path boundary (POST /api/projects, PATCH /api/projects/:id, setup operator project_create) applies it BEFORE validation, so a Linux/macOS user's '~'-repo path binds instead of 400ing — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
