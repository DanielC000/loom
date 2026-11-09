import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4845405e: the bundled tracked-pid helpers (serve-static.mjs in BOTH skill dirs, dev-server.mjs) must
// re-verify a recorded pid's identity before `stop`'s force-kill. A pid the OS has reused for an unrelated
// process — or one whose command line merely CONTAINS the marker as a substring — must be refused, and
// the stranger must survive.
//
// REAL-spawn test: the actual helper CLIs run as child processes; every "stranger" is a node process THIS
// test spawns (never an existing host process), and only pids this test captured are ever killed.
//
// Proves, for serve-static (orchestrate + web-design copies) and dev-server:
//   (a) CONTROL: a genuinely launched server/supervisor is still stopped by `stop` (the check is not a
//       blanket refusal), and `stop` exits 0.
//   (b) a stranger whose command line carries no marker: `stop` REFUSES (nonzero, "REFUSED") and it survives.
//   (c) LOOKALIKES: strangers whose command line carries the marker only as a substring (a `.bak` suffix,
//       a prefix) — refused, survive. A substring `includes` check would kill these.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitUntil } from "./_wait.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ORCH = path.resolve(here, "../assets/skills/orchestrate/scripts");
const WEBD = path.resolve(here, "../assets/skills/web-design/scripts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pidreuse-"));
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hash = (d) => crypto.createHash("sha256").update(d).digest("hex").slice(0, 16);
fs.writeFileSync(path.join(root, "idle.cjs"), "setInterval(() => {}, 1000);\n"); // a shell-safe idle fixture for dev-server's shell:true win32 launch
const cleanupPids = [];
const cleanupFiles = [];
const newDir = (name) => { const d = path.join(root, name); fs.mkdirSync(d); return d; };
const run = (script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 90000, env: { ...process.env, LOOM_DEV_SERVER_PORT_TIMEOUT_MS: "1500" } });
// A stranger this test owns: idles forever; extra argv lets it carry lookalike text on its command line.
const stranger = (...extraArgs) => {
  const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", ...extraArgs], { stdio: "ignore", windowsHide: true });
  cleanupPids.push(c.pid);
  return c;
};

async function serveStaticCases(label, script) {
  const trackFor = (dir) => path.join(os.tmpdir(), `loom-serve-static-${hash(dir)}.json`);
  const plant = (dir, pid) => { cleanupFiles.push(trackFor(dir)); fs.writeFileSync(trackFor(dir), JSON.stringify({ pid, port: 1, dir, startedAt: new Date().toISOString() })); };
  // (a) control
  {
    const dir = newDir(`${label}-a`);
    cleanupFiles.push(trackFor(dir));
    const st = run(script, "start", dir);
    const rec = JSON.parse(fs.readFileSync(trackFor(dir), "utf8"));
    cleanupPids.push(rec.pid);
    const alive = st.status === 0 && isAlive(rec.pid);
    const stop = run(script, "stop", dir);
    await waitUntil(() => !isAlive(rec.pid), { timeoutMs: 10000, label: `${label} (a) server dead` }).catch(() => {});
    check(`${label} (a) CONTROL: a genuinely launched server is stopped (exit 0)`, alive && stop.status === 0 && !isAlive(rec.pid));
  }
  // (b) plain stranger
  {
    const dir = newDir(`${label}-b`);
    const s = stranger();
    plant(dir, s.pid);
    const stop = run(script, "stop", dir);
    check(`${label} (b) stop REFUSES an unrelated pid (nonzero + REFUSED)`, stop.status !== 0 && /REFUSED/.test(stop.stderr));
    check(`${label} (b) the stranger survived`, isAlive(s.pid));
  }
  // (c) lookalikes: marker only as a substring of an argument
  for (const [name, mk] of [["suffix", (m) => m + ".bak"], ["prefix", (m) => "pre-" + m], ["flag=value", (m) => "--track=" + m]]) {
    const dir = newDir(`${label}-c-${name}`);
    const s = stranger("--track", mk(trackFor(dir)));
    plant(dir, s.pid);
    const stop = run(script, "stop", dir);
    check(`${label} (c:${name}) stop REFUSES a lookalike command line (nonzero + REFUSED)`, stop.status !== 0 && /REFUSED/.test(stop.stderr));
    check(`${label} (c:${name}) the lookalike survived`, isAlive(s.pid));
  }
}

async function devServerCases(script) {
  const label = "dev-server";
  const trackFile = (dir) => path.join(os.tmpdir(), `loom-dev-server-${hash(dir)}.json`);
  const plant = (dir, pid, logFile) => { cleanupFiles.push(trackFile(dir)); fs.writeFileSync(trackFile(dir), JSON.stringify({ pid, command: ["x"], dir, startedAt: new Date().toISOString(), logFile, port: null, host: null, url: null })); };
  // (a) control
  {
    const dir = newDir(`${label}-a`);
    cleanupFiles.push(trackFile(dir));
    const st = run(script, "start", dir, "--", process.execPath, path.join(root, "idle.cjs"));
    const rec = JSON.parse(fs.readFileSync(trackFile(dir), "utf8"));
    cleanupPids.push(rec.pid);
    const alive = st.status === 0 && isAlive(rec.pid);
    const stop = run(script, "stop", dir);
    await waitUntil(() => !isAlive(rec.pid), { timeoutMs: 10000, label: `${label} (a) supervisor dead` }).catch(() => {});
    const ok = alive && stop.status === 0 && !isAlive(rec.pid);
    if (!ok) console.log(`  diag: start=${st.status} alive=${alive} stop=${stop.status} stderr=${stop.stderr}`);
    check(`${label} (a) CONTROL: a genuinely launched supervisor is stopped (exit 0)`, ok);
  }
  // (b) plain stranger
  {
    const dir = newDir(`${label}-b`);
    const logFile = path.join(root, `${label}-b.log`);
    const s = stranger();
    plant(dir, s.pid, logFile);
    const stop = run(script, "stop", dir);
    check(`${label} (b) stop REFUSES an unrelated pid (nonzero + REFUSED)`, stop.status !== 0 && /REFUSED/.test(stop.stderr));
    check(`${label} (b) the stranger survived`, isAlive(s.pid));
  }
  // (c) lookalikes: marker only as a substring (incl. the pre-fix shape: the path embedded in a JSON payload)
  const lookalikes = [
    ["suffix", (m) => ["--dev-server-log", m + ".bak"]],
    ["prefix", (m) => ["--dev-server-log", "pre-" + m]],
    ["json-payload", (m) => [JSON.stringify({ logPath: m })]],
    ["wrong-flag", (m) => ["--other-flag", m]],
  ];
  for (const [name, mk] of lookalikes) {
    const dir = newDir(`${label}-c-${name}`);
    const logFile = path.join(root, `${label}-c-${name}.log`);
    const s = stranger(...mk(logFile));
    plant(dir, s.pid, logFile);
    const stop = run(script, "stop", dir);
    check(`${label} (c:${name}) stop REFUSES a lookalike command line (nonzero + REFUSED)`, stop.status !== 0 && /REFUSED/.test(stop.stderr));
    check(`${label} (c:${name}) the lookalike survived`, isAlive(s.pid));
  }
}

try {
  await serveStaticCases("serve-static[orchestrate]", path.join(ORCH, "serve-static.mjs"));
  await serveStaticCases("serve-static[web-design]", path.join(WEBD, "serve-static.mjs"));
  await devServerCases(path.join(ORCH, "dev-server.mjs"));
} finally {
  for (const pid of cleanupPids) { try { if (pid && isAlive(pid)) process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 500)); // let killed processes release their handles
  for (const f of cleanupFiles) { try { fs.unlinkSync(f); } catch { /* absent */ } }
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best-effort temp cleanup */ }
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
