import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// `loom open --print-url` (card ab8eb07a) — the explicit, opt-in tokenized-URL printer for a tunnelled
// browser. Runs the REAL bin/loom.mjs as a subprocess against a temp LOOM_HOME. Proves:
//   - prints http://<host>:<port>/?token=<secret> on STDOUT, defaults host 127.0.0.1, honors --host/--port;
//   - warns on STDERR (never stdout) that the URL is a live credential, and stdout carries the URL only;
//   - `status` (running AND not running) output never contains the token — asserted against a fake daemon;
//   - the source never routes the secret URL to console.log outside the print-url path (static scan);
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
  // (2) --host / --port (tunnel's local address), incl. a hostname and IPv6.
  {
    const r = await runLoom(["open", "--print-url", "--host", "my-box.example.com", "--port=4400"]);
    check("--host hostname + --port=", r.stdout.trim() === `http://my-box.example.com:4400/?token=${SECRET}`);
    const r6 = await runLoom(["open", "--print-url", "--host", "::1", "-p", "4317"]);
    check("--host IPv6 is bracketed", r6.stdout.trim() === `http://[::1]:4317/?token=${SECRET}`);
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
  // (6) static: the secret-bearing URL is only ever logged from the explicit print-url function.
  {
    const src = fs.readFileSync(BIN, "utf8");
    check("no console.* call takes urlWithToken(", !/console\.\w+\([^;\n]*urlWithToken\(/.test(src));
    const printers = src.match(/console\.log\([^;\n]*\?token=\$\{[^;\n]*\)/g) || [];
    check("exactly one console.log embeds ?token= (the print-url path)", printers.length === 1);
    // negative control: the scan pattern DOES match a known-bad line.
    check("control: scan pattern flags console.log(urlWithToken(url))", /console\.\w+\([^;\n]*urlWithToken\(/.test("console.log(urlWithToken(url));"));
  }
  // (7) input validation: flag scoping + host/port smuggling.
  {
    check("--print-url only on open", parseArgs(["start", "--print-url"]).exitCode === 2 && parseArgs(["--print-url"]).exitCode === 2);
    check("--host requires --print-url", parseArgs(["open", "--host", "x.com"]).exitCode === 2);
    check("valid combo parses", (() => { const r = parseArgs(["open", "--print-url", "--host", "h.example", "--port", "80"]); return r.error === null && r.printUrl === true && r.host === "h.example" && r.port === 80; })());
    for (const bad of ["evil.com/path", "a@b.com", "a.com:80", "a.com?x=1", "a.com#f", "http://a.com", "a b", "a.com\n", "", "-a.com", "a..com", "[a.com]", "a.com/", "%41.com", "::1]"]) {
      check(`rejects host ${JSON.stringify(bad)}`, normalizeUrlHost(bad) === null && parseArgs(["open", "--print-url", "--host", bad]).exitCode === 2);
    }
    check("host missing its value → exit 2", parseArgs(["open", "--print-url", "--host"]).exitCode === 2);
    check("accepts IPv4 / bracketed IPv6", normalizeUrlHost("10.0.0.5") === "10.0.0.5" && normalizeUrlHost("[::1]") === "[::1]");
    check("bad port rejected", parseArgs(["open", "--print-url", "--port", "0"]).exitCode === 2 && parseArgs(["open", "--print-url", "--port", "x"]).exitCode === 2);
    const r = await runLoom(["open", "--print-url", "--host", "a.com/x"]);
    check("subprocess: bad host → exit 2, nothing on stdout", r.code === 2 && r.stdout === "");
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall cli-print-url checks passed");
