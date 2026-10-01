import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// `bin/service.mjs`'s `isServiceRegistered()` (card 279c0208, point 2) — the read-only detection `loom
// update` uses to decide whether to hint at re-running `loom service install`. Unlike cli-service.mjs
// (which NEVER executes systemctl/launchctl/schtasks), this file's very subject calls `runStep`, which
// DOES shell out — so it can't stay fully OS-tool-free and lives in its own file rather than breaking that
// file's stated invariant. Kept hermetic anyway, on two different platform choices so neither case can be
// swayed by ambient host state:
//   - the "not registered" case needs a platform whose corresponding OS tool is genuinely ABSENT from
//     PATH on THIS host, so the query call deterministically ENOENTs (`ok:false`) regardless of anything
//     else here. WHICH platform that is depends on the host running this test: on Windows, both
//     `systemctl` and `launchctl` are normally absent; on a real Linux box (incl. ubuntu-latest CI,
//     card 279c0208 review — `systemctl` DOES exist there, so hard-coding `platform: "linux"` is NOT
//     hermetic on that host), only `launchctl` is; on a real Mac, only `systemctl`. `pickAbsentToolPlatform`
//     below probes both at run time and picks whichever this host actually lacks — no fixed platform
//     literal that could be wrong on a different host.
//   - the "registered" case uses platform "win32" with LOOM_HOME redirected to a throwaway test-owned
//     temp dir (win32's artifactPath honors `loomHome`, unlike linux/darwin's which are hard-tied to
//     `os.homedir()` — see servicePlan). This DOES run a real, read-only `schtasks /query /tn Loom` when
//     the current host actually has `schtasks` (Windows) — harmless (it neither registers nor
//     unregisters anything) — or ENOENTs harmlessly when it doesn't (Linux/Mac CI). Either way the
//     assertion never depends on what that query returns: the artifact file this test creates makes the
//     OR unconditionally true regardless, so a real "Loom" task happening to already exist on this box
//     (or not) can't flip the result.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_BIN = path.join(__dirname, "..", "..", "..", "bin"); // packages/daemon/test → repo root/bin
const { isServiceRegistered } = await import(pathToFileURL(path.join(REPO_BIN, "service.mjs")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// True if `cmd` cannot be found on PATH at all (ENOENT) — never "exists and ran successfully vs. failed";
// only absence is what makes a platform's query deterministically ENOENT-based for the test below. Any
// OTHER outcome (a real run, any exit code, any other spawn error) is treated as "might exist" — the
// conservative direction, since this is used to CHOOSE a platform we can trust to be absent, not to prove
// one is present.
function toolExists(cmd) {
  try {
    const r = spawnSync(cmd, ["--help"], { encoding: "utf8", timeout: 2000 });
    return !(r.error && r.error.code === "ENOENT");
  } catch {
    return true;
  }
}

// Picks a platform whose OS query tool is verified absent on THIS host, or null if neither is (should not
// happen in practice — systemctl and launchctl are mutually-exclusive-OS tools).
function pickAbsentToolPlatform() {
  if (!toolExists("systemctl")) return { platform: "linux", tool: "systemctl" };
  if (!toolExists("launchctl")) return { platform: "darwin", tool: "launchctl" };
  return null;
}

// --- NOT registered: OS tool verified absent on this host (ENOENT) + no artifact file → false ----------
{
  const absent = pickAbsentToolPlatform();
  if (absent) {
    check(
      `not registered: queryCmd tool (${absent.tool}) verified absent on this host + no artifact file → false`,
      isServiceRegistered({ platform: absent.platform }) === false,
    );
  } else {
    console.log("SKIP  not-registered check — both systemctl and launchctl are present on this host; no platform's query tool can be relied on to ENOENT here (should not happen in practice).");
  }
}

// --- registered: artifact file present forces the fallback OR to true, whatever the live query says ---
{
  const priorHome = process.env.LOOM_HOME;
  const tmpHome = mkdtempManaged("loom-service-registered-");
  process.env.LOOM_HOME = tmpHome;
  try {
    check(
      "registered check, before the artifact exists, is NOT forced true by this test's own setup alone",
      // Not asserted true/false here (a real live "Loom" task could legitimately already exist on this
      // box) — this only proves the fixture dir itself carries no artifact yet, so the next check's TRUE
      // is attributable to the file this test creates, not to leftover state.
      !fs.existsSync(path.join(tmpHome, "service", "Loom.xml")),
    );

    fs.mkdirSync(path.join(tmpHome, "service"), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, "service", "Loom.xml"), "<Task/>");

    check(
      "registered: artifact file present under LOOM_HOME → true (independent of the live schtasks query)",
      isServiceRegistered({ platform: "win32" }) === true,
    );
  } finally {
    if (priorHome === undefined) delete process.env.LOOM_HOME;
    else process.env.LOOM_HOME = priorHome;
  }
}

// --- never throws on a probe failure (unsupported platform) -----------------------------------------
check(
  "unsupported platform → false, never throws",
  (() => { try { return isServiceRegistered({ platform: "sunos" }) === false; } catch { return false; } })(),
);

console.log(failures === 0
  ? "\n✅ ALL PASS — isServiceRegistered() detects a registered OS-autostart service via the OS query OR the artifact file, hermetically on any host (no dependency on real ambient registration state, and no hard-coded assumption about which OS tool is absent), and never throws."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
