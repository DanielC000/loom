import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// `loom open --print-url` (card ab8eb07a) — the explicit, opt-in tokenized-URL printer for a tunnelled
// browser. Runs the REAL bin/loom.mjs as a subprocess against a temp LOOM_HOME. Proves:
//   - prints http://<host>:<port>/?token=<secret> on STDOUT, defaults host 127.0.0.1, honors --host/--port;
//   - warns on STDERR (never stdout) that the URL is a live credential, and stdout carries the URL only;
//   - `status` (running AND not running) output never contains the token — asserted against a fake daemon;
//   - STRUCTURE: no exported function returns a tokenized URL; openBrowser/printUrlCmd (the two sinks) are
//     exercised through injected launch/write seams (card 85671808);
//   - host/port input validation rejects anything that could smuggle characters into the URL;
//   - a missing credential file is a clean exit 1 with no URL.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "..", "..", "bin", "loom.mjs");
const { parseArgs, normalizeUrlHost } = await import(pathToFileURL(BIN).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loom-print-url-"));
const SECRET = "s3cr3t-TOKEN_0123456789abcdef";
fs.writeFileSync(path.join(home, "gateway-loopback.key"), SECRET + "\n");

function runLoom(args, loomHome = home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, LOOM_HOME: loomHome, LOOM_PORT: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  // (1) default: loopback host, resolved port, token, stdout = URL only.
  {
    const r = await runLoom(["open", "--print-url", "--port", "5000"]);
    check("prints tokenized URL on stdout", r.code === 0 && r.stdout.trim() === `http://127.0.0.1:5000/?token=${SECRET}`);
    check("stdout is the URL and nothing else (one line)", r.stdout.trim().split("\n").length === 1);
    check("stderr warns it is a live credential", /WARNING/.test(r.stderr) && /credential/.test(r.stderr));
    check("the token never appears on stderr", !r.stderr.includes(SECRET));
  }
  // (2) --host is restricted to the two names the daemon's rebind guard serves (127.0.0.1, localhost).
  {
    const r = await runLoom(["open", "--print-url", "--host", "localhost", "--port=4400"]);
    check("--host localhost + --port=", r.code === 0 && r.stdout.trim() === `http://localhost:4400/?token=${SECRET}`);
    const r4 = await runLoom(["open", "--print-url", "--host=127.0.0.1", "-p", "4317"]);
    check("--host=127.0.0.1", r4.code === 0 && r4.stdout.trim() === `http://127.0.0.1:4317/?token=${SECRET}`);
    for (const bad of ["::1", "[::1]", "my-box.example.com", "fe80::1%eth0", "10.0.0.5", "LOCALHOST"]) {
      const rb = await runLoom(["open", "--print-url", "--host", bad]);
      check(`subprocess: --host ${JSON.stringify(bad)} → exit 2, nothing on stdout`, rb.code === 2 && rb.stdout === "" && /127\.0\.0\.1 or localhost/.test(rb.stderr));
    }
  }
  // (3) the token is percent-encoded so an odd credential cannot break out of the query string.
  {
    const odd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-print-url-odd-"));
    fs.writeFileSync(path.join(odd, "gateway-loopback.key"), "a b&c#d\n");
    const r = await runLoom(["open", "--print-url", "--port", "1234"], odd);
    check("token is URL-encoded", r.stdout.trim() === "http://127.0.0.1:1234/?token=a%20b%26c%23d");
    fs.rmSync(odd, { recursive: true, force: true });
  }
  // (4) missing credential file → exit 1, no URL on stdout.
  {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "loom-print-url-empty-"));
    const r = await runLoom(["open", "--print-url", "--port", "1234"], empty);
    check("no credential file → exit 1, empty stdout", r.code === 1 && r.stdout === "" && /no access credential/.test(r.stderr));
    // an unreadable key (a directory in its place → EISDIR, portable stand-in for EACCES) is NOT "missing".
    fs.mkdirSync(path.join(empty, "gateway-loopback.key"));
    const re = await runLoom(["open", "--print-url", "--port", "1234"], empty);
    check("unreadable credential → exit 1, honest read-error message (not 'start the daemon')", re.code === 1 && re.stdout === "" && /could not read/.test(re.stderr) && /EISDIR/.test(re.stderr) && !/start the daemon/.test(re.stderr));
    fs.rmSync(empty, { recursive: true, force: true });
  }
  // (5) `status` never carries the token — against a fake running daemon AND with nothing running.
  {
    const srv = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ version: "9.9.9" })); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const up = await runLoom(["status", "--port", String(port)]);
    check("status (running) exits 0 and reports the daemon", up.code === 0 && /running/.test(up.stdout));
    check("status (running) output never contains the token", !up.stdout.includes(SECRET) && !up.stderr.includes(SECRET) && !/token=/.test(up.stdout + up.stderr));
    await new Promise((r) => srv.close(r));
    const down = await runLoom(["status", "--port", String(port)]);
    check("status (not running) output never contains the token", down.code === 1 && !down.stdout.includes(SECRET) && !down.stderr.includes(SECRET));
  }
  // (6) STRUCTURE (card 85671808), not a text scan: the tokenized URL exists only inside the two sinks.
  {
    const mod = await import(pathToFileURL(BIN).href);
    // (a) no exported function is a tokenized-URL producer: call every exported function with plausible
    // inputs under the temp LOOM_HOME and assert none RETURNS a string carrying the secret.
    process.env.LOOM_HOME = home;
    const returned = [];
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== "function" || name === "printUrlCmd" || name === "openBrowser") continue;
      for (const args of [[], ["http://127.0.0.1:1"], ["127.0.0.1"], [["open"]]]) {
        try { returned.push(name + "=" + JSON.stringify(fn(...args))); } catch { /* ignore */ }
      }
    }
    check("no exported helper returns the secret (exports: " + Object.keys(mod).join(",") + ")", returned.length > 0 && !returned.some((r) => r.includes(SECRET)));
    check("tokenizedUrl / urlWithToken are not exported", !("tokenizedUrl" in mod) && !("urlWithToken" in mod));
    // (b) sink 1: openBrowser takes a BARE origin and appends the token itself, only to its launcher.
    const launched = [];
    const returnedByOpen = mod.openBrowser("http://127.0.0.1:5000", { launch: (u) => launched.push(u) });
    check("openBrowser hands the launcher the tokenized URL", launched.length === 1 && launched[0] === `http://127.0.0.1:5000/?token=${SECRET}`);
    check("openBrowser returns nothing (no tokenized URL escapes as a value)", returnedByOpen === undefined);
    const noKey = fs.mkdtempSync(path.join(os.tmpdir(), "loom-print-url-nokey-"));
    process.env.LOOM_HOME = noKey;
    const bare = [];
    mod.openBrowser("http://127.0.0.1:5000", { launch: (u) => bare.push(u) });
    check("openBrowser degrades to the bare origin when no credential file exists", bare[0] === "http://127.0.0.1:5000");
    fs.rmSync(noKey, { recursive: true, force: true });
    process.env.LOOM_HOME = home;
    // (c) sink 2: printUrlCmd writes the tokenized URL exactly once, to its injected writer, returning only an exit code.
    const written = [];
    const origErr = console.error; console.error = () => {};
    let code;
    try { code = mod.printUrlCmd({ port: 5000, host: undefined }, { write: (u) => written.push(u) }); } finally { console.error = origErr; }
    check("printUrlCmd writes the tokenized URL once, via its writer, and returns an exit code", code === 0 && written.length === 1 && written[0] === `http://127.0.0.1:5000/?token=${SECRET}`);
    // (d) negative control: an openBrowser that leaked via console would be observable through the same seam.
    const seen = [];
    const origLog = console.log; console.log = (...a) => seen.push(a.join(" "));
    try { mod.openBrowser("http://127.0.0.1:5000", { launch: (u) => console.log(u) }); } finally { console.log = origLog; }
    check("control: a launcher that prints IS observable as a console leak (detector can fail)", seen.some((l) => l.includes(SECRET)));
    const seen2 = [];
    console.log = (...a) => seen2.push(a.join(" "));
    try { mod.openBrowser("http://127.0.0.1:5000", { launch: () => {} }); } finally { console.log = origLog; }
    check("openBrowser itself logs nothing to console.log", seen2.length === 0);
  }
  // (7) input validation: flag scoping + host/port smuggling.
  {
    check("--print-url only on open", parseArgs(["start", "--print-url"]).exitCode === 2 && parseArgs(["--print-url"]).exitCode === 2);
    check("--host requires --print-url", parseArgs(["open", "--host", "x.com"]).exitCode === 2);
    check("valid combo parses", (() => { const r = parseArgs(["open", "--print-url", "--host", "localhost", "--port", "80"]); return r.error === null && r.printUrl === true && r.host === "localhost" && r.port === 80; })());
    for (const bad of ["evil.com/path", "a@b.com", "a.com:80", "a.com?x=1", "a.com#f", "http://a.com", "a b", "a.com\n", "", "-a.com", "a..com", "[a.com]", "a.com/", "%41.com", "::1]", "::1", "[::1]", "fe80::1%eth0", "h.example", "10.0.0.5"]) {
      check(`rejects host ${JSON.stringify(bad)}`, normalizeUrlHost(bad) === null && parseArgs(["open", "--print-url", "--host", bad]).exitCode === 2);
    }
    check("host missing its value → exit 2", parseArgs(["open", "--print-url", "--host"]).exitCode === 2);
    check("accepts exactly 127.0.0.1 and localhost", normalizeUrlHost("127.0.0.1") === "127.0.0.1" && normalizeUrlHost("localhost") === "localhost");
    check("bad port rejected", parseArgs(["open", "--print-url", "--port", "0"]).exitCode === 2 && parseArgs(["open", "--print-url", "--port", "x"]).exitCode === 2);
    const r = await runLoom(["open", "--print-url", "--host", "a.com/x"]);
    check("subprocess: bad host → exit 2, nothing on stdout", r.code === 2 && r.stdout === "");
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall cli-print-url checks passed");
