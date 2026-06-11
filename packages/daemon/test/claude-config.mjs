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
import { ensureTrusted, discoverProjectMcpServerNames } from "../dist/pty/claude-config.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const keyFor = (dir) => path.resolve(dir).replace(/\\/g, "/");
const entryFor = (cfgPath, key) => JSON.parse(fs.readFileSync(cfgPath, "utf8")).projects?.[key];
const trusted = (cfgPath, key) => {
  const e = entryFor(cfgPath, key);
  return e?.hasTrustDialogAccepted === true && e?.hasCompletedProjectOnboarding === true;
};
const noTmpLeft = (dir) => fs.readdirSync(dir).every((f) => !f.includes(".loom.tmp"));

const root = path.join(os.tmpdir(), `loom-claude-config-test-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });

// Snapshot the real ~/.claude.json (captured with the REAL homedir, before any env tweaks)
// so we can prove at the end that the whole test left it byte-for-byte unchanged.
const realJson = path.join(os.homedir(), ".claude.json");
const realBefore = fs.existsSync(realJson) ? fs.readFileSync(realJson) : null;

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

  ensureTrusted(projA);
  check("CLAUDE_CONFIG_DIR set → trust written to <dir>/.claude.json", fs.existsSync(isoJson) && trusted(isoJson, keyFor(projA)));
  check("CLAUDE_CONFIG_DIR set → atomic temp file cleaned up (no .loom.tmp left)", noTmpLeft(configDir));

  // idempotent: already-trusted dir is a no-op and stays trusted
  ensureTrusted(projA);
  check("CLAUDE_CONFIG_DIR set → idempotent re-call keeps it trusted", trusted(isoJson, keyFor(projA)));

  // a second project lands its own entry; both coexist, still no temp leftover (unique-suffix
  // temp name — fast-follow #3 — means concurrent calls can't collide on a shared .loom.tmp).
  const projB = path.join(root, "projB");
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
      ensureTrusted(plainWt);
      const pe = entryFor(path.join(plainCfgDir, ".claude.json"), keyFor(plainWt));
      check("ensureTrusted → no up-tree .mcp.json ⇒ trust-only entry, no MCP keys",
        pe?.hasTrustDialogAccepted === true && !("disabledMcpjsonServers" in pe) && !("enabledMcpjsonServers" in pe));
    }
  } else {
    console.log("SKIP  mcp-prevention — os.homedir() not redirectable here; not risking the real file");
  }
} finally {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
}

// === 3. The whole test never mutated the real ~/.claude.json. ===
const realAfter = fs.existsSync(realJson) ? fs.readFileSync(realJson) : null;
check("real ~/.claude.json byte-identical before/after the whole test",
  (realBefore === null && realAfter === null) || (!!realBefore && !!realAfter && realBefore.equals(realAfter)));

console.log(failures === 0
  ? "\nALL PASS — ensureTrusted honors CLAUDE_CONFIG_DIR and never touches the real ~/.claude.json."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
