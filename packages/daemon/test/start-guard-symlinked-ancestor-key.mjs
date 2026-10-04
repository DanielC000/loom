import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// Card 4e026f35 round 3 item 5: `canonicalLoomHome` used to fall back to a plain `path.resolve(loomHome)`
// whenever the home directory didn't exist yet (a genuinely first-ever `loom start`), which does NOT
// resolve a symlink/junction anywhere in the path's ANCESTOR chain. A launcher racing before the dir
// exists and a launcher racing just after it has been created (by the first launcher's own mkdir) would
// then compute DIFFERENT canonical keys for the SAME real directory whenever an ancestor is a
// symlink/junction — defeating the guard's whole mutual-exclusion purpose for exactly the two launchers
// it exists to serialize.
//
// This test reproduces that shape directly: a holder acquires the guard through a loomHome path reached
// via a symlinked/junctioned ancestor BEFORE the leaf directory exists, then (mirroring the real spawn
// flow, where the guard is acquired first and the daemon/supervisor mkdirs its own home afterward) the
// leaf directory is created while the holder still holds, and a second attempt races in through the SAME
// symlinked path. The two must compute the identical key — proven by the second attempt being refused.
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { reserveHermeticPort } from "./_hermetic-port.mjs";
import { acquireStartGuard } from "../../../bin/lib/start-guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// win32/linux have a real OS-released primitive (the property under test); darwin/other are a
// deliberate no-op (decision 4e026f35) with nothing to prove here beyond "it still always acquires".
const expectExclusion = process.platform === "win32" || process.platform === "linux";

const root = mkdtempManaged("start-guard-symlinked-ancestor-");
const realDir = path.join(root, "real-loom-root");
fs.mkdirSync(realDir, { recursive: true });
const linkDir = path.join(root, "link-to-real");
// On win32 a directory junction needs no elevated privilege (unlike a symlink); POSIX uses an ordinary
// directory symlink.
fs.symlinkSync(realDir, linkDir, process.platform === "win32" ? "junction" : "dir");

const loomHome = path.join(linkDir, ".loom"); // deliberately does NOT exist yet
const port = await reserveHermeticPort();

check("[symlinked-ancestor] precondition: the leaf home directory does not exist yet", !fs.existsSync(loomHome));

// Launcher A: the genuinely-first-ever-start shape — acquires through the symlinked ancestor while the
// leaf directory is still absent.
const guardA = await acquireStartGuard({ loomHome, port });
check("[symlinked-ancestor] launcher A (home dir absent) acquires", guardA.acquired === true);

// Mirrors the real spawn flow: the guard is acquired FIRST; the home directory is created afterward (by
// the daemon/supervisor itself), not by this module.
fs.mkdirSync(loomHome, { recursive: true });

// Launcher B races in now that the leaf directory exists, reached through the SAME symlinked ancestor —
// it must compute the SAME canonical key as A and therefore be refused.
const guardB = await acquireStartGuard({ loomHome, port });
if (expectExclusion) {
  check("[symlinked-ancestor] launcher B (home dir now present) is REFUSED — same canonical key as A", guardB.acquired === false && guardB.code === "EADDRINUSE");
} else {
  check("[symlinked-ancestor] launcher B on a no-op platform still acquires (nothing to exclude)", guardB.acquired === true);
}

guardA.release();
if (guardB.acquired) guardB.release();

// After A releases, a fresh attempt through the same symlinked path (leaf now exists) must still acquire
// — confirming the guard target itself is usable post-release, not merely wedged open.
const guardC = await acquireStartGuard({ loomHome, port });
check("[symlinked-ancestor] after release, a fresh attempt through the same path acquires", guardC.acquired === true);
guardC.release();

console.log(failures === 0
  ? "\n✅ ALL PASS — acquireStartGuard derives the SAME canonical key for a LOOM_HOME reached through a symlinked/junctioned ancestor, whether or not the leaf directory existed yet at computation time."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
