import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Live end-to-end for the skills feature, NON-DESTRUCTIVE to the user's running daemon: boots a
// SEPARATE daemon (new build) on an alt port + temp LOOM_HOME, spawns a session into a FRESH project,
// and proves the real spawn path now:
//   1. boots past the plugin-MCP enable-prompt unattended (engine id captured) — the host.ts Esc dismiss;
//   2. injects Loom's managed skills into the project as project-local (doc-hygiene + a marker).
// Spawns one real claude. Surgically removes the trust key it adds to ~/.claude.json. Run after build.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";

const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u) => (await fetch(BASE + u)).json();
const post = async (u, b) => (await fetch(BASE + u, { method: "POST", headers: b ? { "content-type": "application/json" } : undefined, body: b ? JSON.stringify(b) : undefined })).json();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const home = path.join(os.tmpdir(), `loom-skills-e2e-home-${Date.now()}`);
const repo = path.join(os.tmpdir(), `loom-skills-e2e-repo-${Date.now()}`);
fs.mkdirSync(path.join(home, "skills", "loom-e2e-marker"), { recursive: true });
fs.writeFileSync(path.join(home, "skills", "loom-e2e-marker", "SKILL.md"), "---\nname: loom-e2e-marker\ndescription: e2e marker\n---\nmarker");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# e2e\n");
execSync(`git init -q && git add . && git -c user.email=e2e@loom -c user.name=e2e commit -q -m init`, { cwd: repo });

const realClaudeJson = path.join(os.homedir(), ".claude.json");
const trustKey = path.resolve(repo).replace(/\\/g, "/");
const hadKey = (() => { try { return trustKey in (JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}); } catch { return false; } })();

let daemon = null;
try {
  daemon = spawn(process.execPath, [path.resolve("packages/daemon/dist/index.js")],
    { env: { ...process.env, LOOM_HOME: home, LOOM_PORT: String(PORT), LOOM_SCHEDULER_ENABLED: "0" }, stdio: "ignore" });

  // wait for listen
  let up = false;
  for (let i = 0; i < 30 && !up; i++) { await sleep(1000); try { await get("/api/projects"); up = true; } catch { /* not yet */ } }
  check("daemon up on alt port", up);
  if (!up) throw new Error("daemon never listened");

  const P = await post("/api/projects", { name: `E2E-${Date.now()}`, repoPath: repo, vaultPath: repo });
  const agent = await post(`/api/projects/${P.id}/agents`, { name: "t", startupPrompt: "Reply with exactly READY and stop. Do not use tools." });
  const session = await post(`/api/agents/${agent.id}/sessions`, {});
  check("session spawned live", session.processState === "live");

  // Engine id captured ⇒ boot got PAST the plugin-MCP prompt (host.ts Esc dismiss worked).
  let engineId = null;
  for (let i = 0; i < 60 && !engineId; i++) { await sleep(1000); engineId = (await get("/api/sessions")).find((s) => s.id === session.id)?.engineSessionId; }
  check("engine id captured (booted past the plugin-MCP prompt unattended)", !!engineId);

  // Skills injected into the project as project-local.
  const skillsDir = path.join(repo, ".claude", "skills");
  check("Loom marker skill injected (project-local)", fs.existsSync(path.join(skillsDir, "loom-e2e-marker", "SKILL.md")));
  check("bundled doc-hygiene injected", fs.existsSync(path.join(skillsDir, "doc-hygiene", "SKILL.md")));
  check(".git/info/exclude hides the injected skills", (() => { try { return fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8").includes("/.claude/skills/loom-e2e-marker"); } catch { return false; } })());

  try { await post(`/api/sessions/${session.id}/stop`, { mode: "hard" }); } catch { /* ignore */ }
  await sleep(1000);
} finally {
  try { daemon?.kill(); } catch { /* ignore */ }
  await sleep(1500);
  if (!hadKey) {
    try { const c = JSON.parse(fs.readFileSync(realClaudeJson, "utf8")); if (c.projects && trustKey in c.projects) { delete c.projects[trustKey]; fs.writeFileSync(realClaudeJson, JSON.stringify(c, null, 2)); } } catch { /* ignore */ }
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ E2E PASS — fresh project boots unattended and gets Loom's skills injected project-local." : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
