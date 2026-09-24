// Card fb119c4c: hermetic proof of the real-codex usage-limit skip (see _codex-real-spawn-lock.mjs's
// "Usage-limit preflight" block for the design). A FIXTURE codex CLI stands in for the real one, so this
// spends no quota and needs no codex install. Contract under test:
//   - the fixture prints codex's usage-limit error  => the caller SKIPS (exit 0) with a `WARN  SKIP` line
//     naming the quota and the reset time, and NEVER reaches its own body;
//   - the fixture hangs, or fails with any OTHER error, or is healthy => the caller is NOT skipped (its
//     body runs, so a genuinely broken codex still FAILS in the real test — no skip-on-any-failure).
// Each scenario runs the real acquireCodexRealSpawnLock() in a child process (it calls process.exit on skip).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { detectCodexUsageLimit } from "./_codex-real-spawn-lock.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_URL = pathToFileURL(path.join(HERE, "_codex-real-spawn-lock.mjs")).href;
const LIMIT_TEXT = "ERROR: You've hit your usage limit. Upgrade to Pro, or try again at Sep 28th, 2026 3:46 PM.";

// --- pure detector ---------------------------------------------------------------------------------------
{
  const d = detectCodexUsageLimit(LIMIT_TEXT + "\n");
  check("detector: real usage-limit text => limited", d.limited === true);
  check("detector: reset time is carried in detail", /Sep 28th, 2026 3:46 PM/.test(d.detail ?? ""));
  check("detector: curly apostrophe variant also matches", detectCodexUsageLimit("You’ve hit your usage limit.").limited === true);
  check("NEG: an unrelated error is NOT limited", detectCodexUsageLimit("ERROR: not logged in").limited === false);
  check("NEG: empty output is NOT limited", detectCodexUsageLimit("").limited === false);
  check("NEG: a healthy reply is NOT limited", detectCodexUsageLimit("PONG").limited === false);
}

// --- end-to-end through acquireCodexRealSpawnLock() with a fixture codex --------------------------------
const tmp = mkdtempManaged("loom-codex-usage-limit-");
const winWrapper = process.platform === "win32";

function makeFixtureBin(name, jsBody) {
  const js = path.join(tmp, `${name}.mjs`);
  fs.writeFileSync(js, jsBody);
  if (winWrapper) {
    const cmd = path.join(tmp, `${name}.cmd`);
    fs.writeFileSync(cmd, `@"${process.execPath}" "${js}" %*\r\n`);
    return cmd;
  }
  const sh = path.join(tmp, `${name}.sh`);
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

const childScript = path.join(tmp, "caller.mjs");
fs.writeFileSync(
  childScript,
  `const lock = await import(${JSON.stringify(LOCK_URL)});\n` +
    `const release = await lock.acquireCodexRealSpawnLock();\n` +
    `console.log("BODY-RAN");\nrelease();\n`,
);

function runCaller(bin, idx) {
  const r = spawnSync(process.execPath, [childScript], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      LOOM_CODEX_BIN: bin,
      LOOM_CODEX_USAGE_PROBE_CACHE: path.join(tmp, `probe-cache-${idx}.json`),
      LOOM_CODEX_USAGE_PROBE_TIMEOUT_MS: "1500",
      LOOM_CODEX_REAL_SPAWN_LOCK_PATH: path.join(tmp, "own.lock"),
    },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const limited = runCaller(makeFixtureBin("limited", `console.error(${JSON.stringify(LIMIT_TEXT)}); process.exit(1);`), 1);
check("limited fixture: caller exits 0 (skipped)", limited.code === 0);
check("limited fixture: caller body NEVER ran", !limited.out.includes("BODY-RAN"));
check("limited fixture: loud `WARN  SKIP` line (runner WARN channel shape)", /^WARN {2}SKIP {2}.*USAGE LIMIT/m.test(limited.out));
check("limited fixture: WARN names the reset time", /Sep 28th, 2026 3:46 PM/.test(limited.out));

const hang = runCaller(makeFixtureBin("hang", `setInterval(() => {}, 1000);`), 2);
check("hang fixture: NOT skipped — body runs (a hung codex fails the real test itself)", hang.code === 0 && hang.out.includes("BODY-RAN"));
check("hang fixture: no SKIP warning", !/WARN {2}SKIP/.test(hang.out));

const other = runCaller(makeFixtureBin("other", `console.error("ERROR: model overloaded"); process.exit(1);`), 3);
check("other-error fixture: NOT skipped — body runs", other.code === 0 && other.out.includes("BODY-RAN"));
check("other-error fixture: no SKIP warning", !/WARN {2}SKIP/.test(other.out));

const healthy = runCaller(makeFixtureBin("healthy", `console.log("PONG");`), 4);
check("healthy fixture: NOT skipped — body runs", healthy.code === 0 && healthy.out.includes("BODY-RAN"));

finishAndExit(failures);
