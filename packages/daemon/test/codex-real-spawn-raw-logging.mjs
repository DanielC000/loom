// Unit check (no real codex spawn): the codex real-spawn family opts its OWN process into raw
// message-content logging via `_codex-real-spawn-lock.mjs` — and importing that helper (as
// scripts/test-daemon.mjs does in the parent) must NOT flip the flag. Not covered: that each family file
// calls acquireCodexRealSpawnLock() before spawning (checked by source-text scan below, not by running them).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

const here = path.dirname(fileURLToPath(import.meta.url));
delete process.env.LOOM_LOG_MESSAGE_CONTENT;

const { isLogMessageContentEnabled } = await import("../dist/paths.js");
const lock = await import("./_codex-real-spawn-lock.mjs");

check("importing the helper leaves the flag OFF (parent test-daemon.mjs imports it)", isLogMessageContentEnabled() === false);
check("helper exports enableRawFixtureLogging", typeof lock.enableRawFixtureLogging === "function");
lock.enableRawFixtureLogging?.();
check("after enableRawFixtureLogging(), isLogMessageContentEnabled() === true", isLogMessageContentEnabled() === true);
delete process.env.LOOM_LOG_MESSAGE_CONTENT;
check("negative control: flag OFF again once removed", isLogMessageContentEnabled() === false);

const lockSrc = fs.readFileSync(path.join(here, "_codex-real-spawn-lock.mjs"), "utf8");
const acquireBody = lockSrc.slice(lockSrc.indexOf("export async function acquireCodexRealSpawnLock"));
check("acquireCodexRealSpawnLock() calls enableRawFixtureLogging() before acquiring", /enableRawFixtureLogging\(\);[\s\S]*tryAcquireOnce\(\)/.test(acquireBody));

for (const base of lock.CODEX_REAL_SPAWN_BASENAMES) {
  const src = fs.readFileSync(path.join(here, `${base}.mjs`), "utf8");
  check(`${base} calls acquireCodexRealSpawnLock()`, /acquireCodexRealSpawnLock\(\)/.test(src));
}

process.exit(failures ? 1 : 0);
