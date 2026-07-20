import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fcded408: Playwright's browser_navigate blocks file:// navigation, so eyeballing a static
// on-disk HTML artifact forced a hand-rolled `python -m http.server` per render cycle. Fix (a): a
// dependency-free "serve this dir on a free loopback port, print the URL" helper the orchestrate +
// web-design doctrine points at. HERMETIC + CLAUDE-FREE + NETWORK-LOOPBACK-ONLY: spawns the helper as
// a real child process (it IS the artifact under test — a plain node script, no daemon/dist import)
// and drives it over real HTTP on 127.0.0.1.
//
// Proves:
//   (a) it binds 127.0.0.1 on a free (OS-assigned) port and prints exactly the documented URL line;
//   (b) GET / serves the directory's index.html;
//   (c) GET of a nested file serves it with the right content-type;
//   (d) a missing path 404s rather than leaking anything;
//   (e) the web-design and orchestrate copies are byte-identical — the doctrine in both skills points
//       at its OWN skill-local copy (each skill dir is injected independently), so drift between the
//       two would silently break whichever skill's session doesn't get the fix;
//   (f) an ENCODED traversal request ("%2e%2e%2f") — which the WHATWG URL parser does NOT collapse the
//       way it collapses raw ".." (the encoded "/" blocks segment splitting) — is rejected 403 by the
//       lexical containment check, exercising the guard a raw "../" request never reaches;
//   (g) a SYMLINK inside the served dir pointing OUTSIDE it is never followed to serve the external
//       target's content (the exfil vector `<dir>/leak.html -> /etc/passwd` — the same class rejected
//       when picking loopback-serving over a file:// Playwright allowance in the first place).
//   (h) the tracked-pid `start`/`stop` lifecycle (card 06a1d2c5): `start` spawns a detached server,
//       records its exact pid, and prints the pid + the ACTUAL bound port; the server really serves the
//       dir; a second `start` over the same live dir refuses; `stop` kills EXACTLY that tracked pid (the
//       pid is confirmably gone AND the port stops accepting connections afterward) and removes the
//       tracking file; a `stop` with nothing tracked is a safe no-op — mirrors dev-server.mjs's own
//       tracked-pid lifecycle (see test/dev-server.mjs), never a port/name search.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DESIGN_SCRIPT = path.join(__dirname, "..", "assets", "skills", "web-design", "scripts", "serve-static.mjs");
const ORCHESTRATE_SCRIPT = path.join(__dirname, "..", "assets", "skills", "orchestrate", "scripts", "serve-static.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

check("(0) web-design helper exists", fs.existsSync(WEB_DESIGN_SCRIPT));
check("(0) orchestrate helper exists", fs.existsSync(ORCHESTRATE_SCRIPT));

// (e) the two skill-local copies never drift apart.
check(
  "(e) web-design and orchestrate copies are byte-identical",
  fs.readFileSync(WEB_DESIGN_SCRIPT, "utf8") === fs.readFileSync(ORCHESTRATE_SCRIPT, "utf8"),
);

// A small static-artifact fixture to serve, plus an out-of-root secret and a symlink inside `dir`
// pointing at it — the exfil shape the symlink-follow guard must stop.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-serve-static-"));
fs.writeFileSync(path.join(dir, "index.html"), "<html><body>hello static</body></html>");
fs.mkdirSync(path.join(dir, "sub"));
fs.writeFileSync(path.join(dir, "sub", "style.css"), "body { color: red; }");

const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-serve-static-outside-"));
const secretPath = path.join(outsideDir, "secret.txt");
fs.writeFileSync(secretPath, "top secret — must never be served");

let symlinkSkipReason = null;
try {
  fs.symlinkSync(secretPath, path.join(dir, "leak.html"));
} catch (e) {
  // win32 symlink creation can need an elevated/Developer-Mode privilege (EPERM) — skip the symlink
  // case rather than failing the whole suite over a host permission gap unrelated to the guard itself.
  symlinkSkipReason = (e && e.code) || String(e);
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

// Wait for the helper's single startup line, bounded so a broken helper fails fast instead of hanging
// the suite. Resolves the printed http://127.0.0.1:<port>/ URL.
function waitForUrl(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`serve-static did not print a URL within ${timeoutMs}ms (got: ${JSON.stringify(out)})`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
      const m = out.match(/Serving .* at (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`serve-static exited early (code ${code}); output: ${JSON.stringify(out)}`)); });
  });
}

const child = spawn(process.execPath, [WEB_DESIGN_SCRIPT, dir, "0"], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });

try {
  const url = await waitForUrl(child);
  check("(a) prints a loopback-only URL", /^http:\/\/127\.0\.0\.1:\d+\/$/.test(url));

  const root = await get(url);
  check("(b) GET / → 200", root.status === 200);
  check("(b) GET / serves index.html content", root.body === "<html><body>hello static</body></html>");
  check("(b) GET / sets an html content-type", /text\/html/.test(root.headers["content-type"] || ""));

  const nested = await get(`${url}sub/style.css`);
  check("(c) GET of a nested file → 200", nested.status === 200);
  check("(c) nested file body matches", nested.body === "body { color: red; }");
  check("(c) nested file gets a css content-type", /text\/css/.test(nested.headers["content-type"] || ""));

  const missing = await get(`${url}does-not-exist.html`);
  check("(d) missing path → 404", missing.status === 404);

  // A raw "../" traversal attempt must never surface content from outside `dir` (the URL parser
  // collapses the leading ".." at the root, so this always resolves back under `dir` and 404s).
  const traversal = await get(`${url}../../../../../../etc/passwd`);
  check("(d) a \"../\" request never returns 200", traversal.status !== 200);

  // (f) an ENCODED traversal ("%2e%2e%2f") is NOT collapsed by URL parsing (the encoded "/" blocks
  // segment splitting), so it reaches the lexical containment check un-collapsed and must be 403'd.
  const encodedTraversal = await get(`${url}%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
  check("(f) an encoded \"%2e%2e%2f\" traversal → 403", encodedTraversal.status === 403);

  // (g) a symlink inside the served root pointing outside it must never be followed.
  if (symlinkSkipReason) {
    console.log(`SKIP  (g) symlink-exfil case (symlink creation unavailable: ${symlinkSkipReason})`);
  } else {
    const leak = await get(`${url}leak.html`);
    check("(g) a symlink pointing outside root never returns 200", leak.status !== 200);
    check("(g) a symlink pointing outside root never leaks the secret body", !leak.body.includes("top secret"));
  }
} catch (e) {
  console.log(`FAIL  unexpected error: ${(e && e.stack) || e}`);
  failures++;
} finally {
  child.kill("SIGTERM");
  if (stderr.trim()) console.log(`[serve-static stderr]: ${stderr.trim()}`);
  for (let i = 0; i < 5; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { /* retry */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(outsideDir, { recursive: true, force: true }); break; } catch { /* retry */ } }
}

// (h) tracked-pid start/stop lifecycle — REAL child-process spawn/kill, per the repo's "mocking the
// exec impl never exercises the actual cross-platform spawn/kill" rule.
const isAlivePid = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitUntilLifecycle = async (predicate, timeoutMs = 5000, stepMs = 50) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
};

const ssDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-serve-static-lifecycle-"));
fs.writeFileSync(path.join(ssDir, "index.html"), "<html><body>lifecycle</body></html>");
let ssPid = null;
let ssPort = null;

try {
  const startResult = spawnSync(process.execPath, [ORCHESTRATE_SCRIPT, "start", ssDir], { encoding: "utf8", timeout: 10_000 });
  check("(h) start exits 0", startResult.status === 0);
  const startMatch = /http:\/\/127\.0\.0\.1:(\d+)\/ \(pid (\d+)\)/.exec(startResult.stdout || "");
  check("(h) start prints a URL + pid", !!startMatch);
  ssPort = startMatch ? Number(startMatch[1]) : null;
  ssPid = startMatch ? Number(startMatch[2]) : null;

  check("(h) tracked pid is alive", ssPid != null && isAlivePid(ssPid));

  const ssUrl = `http://127.0.0.1:${ssPort}/`;
  const served = ssPort != null ? await get(ssUrl) : null;
  check(
    "(h) start's server actually serves the dir",
    served != null && served.status === 200 && served.body === "<html><body>lifecycle</body></html>",
  );

  // A second start over the same still-alive dir must refuse, not spawn a second untracked process.
  const doubleStart = spawnSync(process.execPath, [ORCHESTRATE_SCRIPT, "start", ssDir], { encoding: "utf8", timeout: 10_000 });
  check("(h) double-start over a live tracked dir refuses (nonzero exit)", doubleStart.status !== 0);

  const stopResult = spawnSync(process.execPath, [ORCHESTRATE_SCRIPT, "stop", ssDir], { encoding: "utf8", timeout: 10_000 });
  check("(h) stop exits 0", stopResult.status === 0);
  check("(h) stop reports the tracked pid", ssPid != null && stopResult.stdout.includes(String(ssPid)));

  const ssGone = ssPid != null && await waitUntilLifecycle(() => !isAlivePid(ssPid));
  check("(h) tracked pid is gone after stop()", ssGone);

  // The port itself must stop accepting connections too — proves stop() actually tore the listener
  // down, not just that SOME process died.
  let refused = false;
  try { await get(ssUrl); } catch { refused = true; }
  check("(h) port is freed after stop() (connection refused)", refused);

  const noopStop = spawnSync(process.execPath, [ORCHESTRATE_SCRIPT, "stop", ssDir], { encoding: "utf8", timeout: 10_000 });
  check("(h) stop with no tracked server exits 0", noopStop.status === 0);
  check("(h) stop with no tracked server says so, not an error", /nothing to do/.test(noopStop.stdout || ""));
} catch (e) {
  console.log(`FAIL  unexpected error (start/stop lifecycle): ${(e && e.stack) || e}`);
  failures++;
} finally {
  if (ssPid != null && isAlivePid(ssPid)) { try { process.kill(ssPid, "SIGKILL"); } catch { /* best effort */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(ssDir, { recursive: true, force: true }); break; } catch { /* retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — serve-static.mjs serves a static dir over loopback (nested files, 404 on miss, traversal-safe), the web-design/orchestrate copies stay identical, and the tracked-pid start/stop lifecycle works end-to-end."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
