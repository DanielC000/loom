import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// Card 0da5a3f7: `startForeground` (bare `loom`/`loom start`, and — since `loom service` registers
// `loom start --no-open` — an OS-service-managed daemon too) now records its OWN pid the same way
// `startDetached` already did, so `loom stop`/`loom status`/`loom update` can find it. Foreground has no
// separate child process — THIS CLI invocation IS the daemon process (it boots in-process via a dynamic
// import) — so `process.pid` already IS its pid; there is no `<repo-root>/dist/index.js` in this monorepo
// checkout for `startForeground` itself to boot against (see bin/loom.mjs's own header comment: it's
// built to run only against the assembled npm package layout), so this file tests the two small, exported
// functions `startForeground` is wired to (`writeForegroundPidRecord` / `removeForegroundPidRecordIfOwnedBySelf`)
// directly, real filesystem, real `process.pid`, no mocks — plus, structurally, that `startForeground`'s
// source actually calls both. Combined with cli-stop-auth.mjs / cli-stop-pid-identity.mjs (which already
// prove `stop()` correctly processes a pid record of exactly this shape), this closes the loop DoD-1
// claims: "That fixes `loom stop` too."
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "..", "..", "bin", "loom.mjs");
const SRC = fs.readFileSync(BIN, "utf8");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- (1) structural: startForeground actually calls both new functions, before the daemon import -----
{
  const fnBody = SRC.slice(SRC.indexOf("async function startForeground"), SRC.indexOf("async function startDetached"));
  check("startForeground calls writeForegroundPidRecord", /writeForegroundPidRecord\(/.test(fnBody));
  check("startForeground registers removeForegroundPidRecordIfOwnedBySelf on 'exit'", /process\.once\(\s*"exit"\s*,\s*removeForegroundPidRecordIfOwnedBySelf\s*\)/.test(fnBody));
  const writeIdx = fnBody.indexOf("writeForegroundPidRecord(");
  const importIdx = fnBody.indexOf("await import(");
  check("the pid record is written BEFORE the daemon is booted (mirrors startDetached's own ordering)", writeIdx !== -1 && importIdx !== -1 && writeIdx < importIdx);
}

// Card 8378984b: {fresh:true} — the checks below assume NO pre-existing daemon.pid (line 45), which only
// holds under a genuinely pristine home, not merely "whatever useOwnLoomHome's reuse contract hands back".
const home = useOwnLoomHome("loom-fg-pid-", { fresh: true });
const pidPath = path.join(home, "daemon.pid");

// --- (2) writeForegroundPidRecord: same shape startDetached already writes, using process.pid ----------
{
  const mod = await import(pathToFileURL(BIN).href);
  check("writeForegroundPidRecord is exported", typeof mod.writeForegroundPidRecord === "function");
  check("removeForegroundPidRecordIfOwnedBySelf is exported", typeof mod.removeForegroundPidRecordIfOwnedBySelf === "function");

  check("no pid file before writing", !fs.existsSync(pidPath));
  mod.writeForegroundPidRecord({ port: 4317, url: "http://127.0.0.1:4317" });
  check("pid file now exists", fs.existsSync(pidPath));
  const rec = JSON.parse(fs.readFileSync(pidPath, "utf8"));
  check("pid is THIS process's own pid (foreground has no separate child)", rec.pid === process.pid);
  check("port recorded", rec.port === 4317);
  check("url recorded", rec.url === "http://127.0.0.1:4317");
  check("version + startedAt recorded (same shape startDetached writes)", typeof rec.version === "string" && typeof rec.startedAt === "string");

  // --- (3) removal is a no-op for a record NOT owned by us (never clobber a newer/foreign write) -------
  fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid + 1, port: 9999, url: "http://127.0.0.1:9999", version: "0.0.0", startedAt: new Date().toISOString() }, null, 2) + "\n");
  mod.removeForegroundPidRecordIfOwnedBySelf();
  check("a record NOT naming our own pid is left untouched (not removed)", fs.existsSync(pidPath) && JSON.parse(fs.readFileSync(pidPath, "utf8")).pid === process.pid + 1);

  // --- (4) removal DOES clear a record that IS ours ------------------------------------------------
  mod.writeForegroundPidRecord({ port: 4317, url: "http://127.0.0.1:4317" });
  check("our own record is back", fs.existsSync(pidPath) && JSON.parse(fs.readFileSync(pidPath, "utf8")).pid === process.pid);
  mod.removeForegroundPidRecordIfOwnedBySelf();
  check("our own record IS removed", !fs.existsSync(pidPath));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — startForeground writes a pid record (its own process.pid, same shape startDetached uses) before booting the daemon, and removes it again ONLY when it still owns the record — a foreign/newer record is left untouched."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
