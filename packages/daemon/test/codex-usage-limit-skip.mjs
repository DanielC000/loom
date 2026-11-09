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
import { detectCodexUsageLimit, detectCodexAccountRejection } from "./_codex-real-spawn-lock.mjs";

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

// --- pure account-rejection classifier (card 24dea2d3) ---------------------------------------------------
const REJECT_TEXT = `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}`;
{
  const d = detectCodexAccountRejection(REJECT_TEXT);
  check("rejection: the exact captured model_not_found 400 => rejected", d.rejected === true);
  check("rejection: detail carries status, code and vendor message", /400 model_not_found: The 'gpt-6-astra' model is not supported/.test(d.detail ?? ""));
  check("rejection: also matches when prefixed by 'ERROR: ' and surrounded by other lines", detectCodexAccountRejection(`noise\nERROR: ${REJECT_TEXT}\nmore\n`).rejected === true);
  check("rejection: 401 + invalid_api_key => rejected", detectCodexAccountRejection(`{"status":401,"error":{"code":"invalid_api_key","message":"bad key"}}`).rejected === true);
  check("NEG: 429 rate limit (even with a code) is NOT rejected", detectCodexAccountRejection(`{"type":"error","status":429,"error":{"type":"rate_limit","message":"slow down","code":"rate_limit_exceeded"}}`).rejected === false);
  check("NEG: 429 carrying a model_not_found code is still NOT rejected (status gate)", detectCodexAccountRejection(REJECT_TEXT.replace('"status":400', '"status":429')).rejected === false);
  check("NEG: 500 server error is NOT rejected", detectCodexAccountRejection(`{"type":"error","status":500,"error":{"type":"server_error","message":"boom","code":"internal_error"}}`).rejected === false);
  check("NEG: 503 even with model_not_found code is NOT rejected", detectCodexAccountRejection(REJECT_TEXT.replace('"status":400', '"status":503')).rejected === false);
  check("NEG: 400 with an unrelated code is NOT rejected", detectCodexAccountRejection(`{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"bad","code":"context_length_exceeded"}}`).rejected === false);
  check("NEG: prose mentioning the message without a structured error is NOT rejected", detectCodexAccountRejection("The 'x' model is not supported when using Codex with a ChatGPT account.").rejected === false);
  check("NEG: a timeout message is NOT rejected", detectCodexAccountRejection("Error: timed out waiting for reply after 150000ms").rejected === false);
  check("NEG: empty output is NOT rejected", detectCodexAccountRejection("").rejected === false);
  check("NEG: an empty assistant reply is NOT rejected", detectCodexAccountRejection('{"type":"item.completed","item":{"type":"agent_message","text":""}}').rejected === false);
  check("NEG: a wrong reply is NOT rejected", detectCodexAccountRejection("NOPE").rejected === false);
  check("NEG: malformed JSON is NOT rejected", detectCodexAccountRejection('{"status":400,"error":{"code":"model_not_found"').rejected === false);
  check("NEG: null/undefined input is NOT rejected", detectCodexAccountRejection(undefined).rejected === false);
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

const rejected = runCaller(makeFixtureBin("rejected", `console.error("ERROR: " + ${JSON.stringify(REJECT_TEXT)}); process.exit(1);`), 5);
check("rejected fixture: caller exits 0 (skipped)", rejected.code === 0);
check("rejected fixture: caller body NEVER ran", !rejected.out.includes("BODY-RAN"));
check("rejected fixture: loud `WARN  SKIP` line naming the vendor reason", /^WARN {2}SKIP {2}.*ACCOUNT\/model.*model_not_found.*gpt-6-astra/m.test(rejected.out));
check("rejected fixture: says it is an environment precondition", /Environment precondition, not a product failure/.test(rejected.out));

const rate429 = runCaller(makeFixtureBin("rate429", `console.error('ERROR: {"type":"error","status":429,"error":{"type":"rate_limit","code":"rate_limit_exceeded","message":"slow"}}'); process.exit(1);`), 6);
check("429 fixture: NOT skipped — body runs", rate429.code === 0 && rate429.out.includes("BODY-RAN") && !/WARN {2}SKIP/.test(rate429.out));

const err500 = runCaller(makeFixtureBin("err500", `console.error('ERROR: {"type":"error","status":500,"error":{"type":"server_error","code":"model_not_found","message":"x"}}'); process.exit(1);`), 7);
check("500 fixture: NOT skipped — body runs", err500.code === 0 && err500.out.includes("BODY-RAN") && !/WARN {2}SKIP/.test(err500.out));

const empty = runCaller(makeFixtureBin("empty", `process.exit(0);`), 8);
check("empty-reply fixture: NOT skipped — body runs", empty.code === 0 && empty.out.includes("BODY-RAN") && !/WARN {2}SKIP/.test(empty.out));

const healthy = runCaller(makeFixtureBin("healthy", `console.log("PONG");`), 4);
check("healthy fixture: NOT skipped — body runs", healthy.code === 0 && healthy.out.includes("BODY-RAN"));

finishAndExit(failures);
