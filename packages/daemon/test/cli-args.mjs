import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// The management-CLI arg parser (bin/loom.mjs › parseArgs). HERMETIC + side-effect-free: importing the
// bin only defines functions — the CLI dispatch runs ONLY when invoked directly (the bin's
// invokedDirectly guard), never on import, so this test exercises parseArgs in isolation. Proves:
//   - bare `loom` (no command) and `loom start` parse to the SAME start intent (backward-compat);
//   - each subcommand is recognized; an unknown command/flag is a 2-exit error;
//   - --detach/-d, --no-open, --port/-p/--port= and --version/--help map correctly;
//   - a bad port (NaN / out of range) is a 2-exit error.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "..", "..", "bin", "loom.mjs"); // packages/daemon/test → repo root
const { parseArgs } = await import(pathToFileURL(BIN).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// (1) bare invocation = today's behavior: no command, foreground, open, no detach.
{
  const r = parseArgs([]);
  check("bare: command null", r.command === null);
  check("bare: open true, detach false, no error", r.open === true && r.detach === false && r.error === null);
  check("bare: port undefined (resolved at use-site)", r.port === undefined);
}

// (2) `loom start` parses to the same start intent as bare.
{
  const r = parseArgs(["start"]);
  check("start: command 'start'", r.command === "start");
  check("start: open true, detach false", r.open === true && r.detach === false && r.error === null);
}

// (3) each subcommand recognized.
for (const c of ["stop", "status", "restart", "open"]) {
  const r = parseArgs([c]);
  check(`${c}: recognized as command`, r.command === c && r.error === null);
}

// (4) detach (both spellings) + no-open.
check("start --detach", parseArgs(["start", "--detach"]).detach === true);
check("start -d", parseArgs(["start", "-d"]).detach === true);
check("restart --no-open --detach", (() => { const r = parseArgs(["restart", "--no-open", "--detach"]); return r.command === "restart" && r.open === false && r.detach === true; })());

// (5) port forms.
check("start --port 5000", parseArgs(["start", "--port", "5000"]).port === 5000);
check("start -p 5000", parseArgs(["start", "-p", "5000"]).port === 5000);
check("--port=5000 (bare)", (() => { const r = parseArgs(["--port=5000"]); return r.command === null && r.port === 5000; })());

// (6) version / help, with no command (bare flags).
check("--version", (() => { const r = parseArgs(["--version"]); return r.version === true && r.command === null; })());
check("-v", parseArgs(["-v"]).version === true);
check("--help", parseArgs(["--help"]).help === true);
check("-h", parseArgs(["-h"]).help === true);

// (7) errors → exitCode 2.
check("unknown command → error exit 2", (() => { const r = parseArgs(["bogus"]); return r.error !== null && r.exitCode === 2; })());
check("unknown flag → error exit 2", (() => { const r = parseArgs(["start", "--frob"]); return r.error !== null && r.exitCode === 2; })());
check("bad port (NaN) → error exit 2", (() => { const r = parseArgs(["start", "--port", "abc"]); return r.error !== null && r.exitCode === 2; })());
check("bad port (range) → error exit 2", (() => { const r = parseArgs(["start", "--port", "70000"]); return r.error !== null && r.exitCode === 2; })());

console.log(failures === 0
  ? "\n✅ ALL PASS — parseArgs maps bare/start/stop/status/restart/open + flags correctly; bare stays backward-compatible; bad input is a 2-exit error."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
