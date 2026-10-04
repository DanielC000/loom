import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// Card d1c87a06: `canonicalLoomHome` (bin/lib/start-guard.mjs) used `fs.realpathSync`, which does NOT
// expand a win32 8.3 short name (e.g. `LONGNA~1`) to its canonical long form — measured directly (see
// this card's own report): `fs.realpathSync("...\\LONGDI~1")` returns the short spelling byte-for-byte
// unchanged, while `fs.realpathSync.native(...)` resolves both the short and long spellings to the
// IDENTICAL canonical path. So a LOOM_HOME given as its 8.3 short form and the SAME LOOM_HOME given in
// long form used to hash to two different start-guard keys — defeating the guard's mutual-exclusion
// purpose for exactly the two launchers it exists to serialize, whenever one happened to be invoked with
// a short-form path (common when a parent process/shell itself only knows the short spelling, e.g. some
// legacy launchers, batch files, or a `GetShortPathName`-based wrapper).
//
// This test reproduces that shape directly: acquire the guard through the LONG spelling of a real
// directory, then attempt a second acquire through its OS-generated 8.3 SHORT spelling — they must
// compute the identical canonical key, proven by the second attempt being refused.
//
// 8.3 short-name generation is a win32-only, PER-VOLUME feature that can be administratively disabled
// (`fsutil 8dot3name query`, needs elevation to even query) — off win32 entirely, or on a volume with it
// disabled, there is no live short-name spelling to test against at all. In either case this test falls
// back to a STRUCTURAL check instead of silently passing vacuously: it asserts the real source actually
// calls `fs.realpathSync.native(`, not the plain `fs.realpathSync(`, inside `canonicalLoomHome` — the
// exact code-shape distinction the live scenario would otherwise exercise.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { reserveHermeticPort } from "./_hermetic-port.mjs";
import { acquireStartGuard } from "../../../bin/lib/start-guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// win32/linux have a real OS-released primitive (the property under test); darwin/other are a
// deliberate no-op (decision 4e026f35) — same convention as start-guard-race.mjs / the symlinked-ancestor
// test.
const expectExclusion = process.platform === "win32" || process.platform === "linux";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START_GUARD_SOURCE_PATH = path.join(__dirname, "..", "..", "..", "bin", "lib", "start-guard.mjs");

// Structural fallback (used off win32, or when 8.3 generation is disabled on the host volume): reads
// canonicalLoomHome's own function body text and confirms it resolves via `fs.realpathSync.native(`
// (which expands an 8.3 short name) rather than the plain `fs.realpathSync(` (which does not — measured
// directly in this card's own report).
function canonicalLoomHomeUsesRealpathNative() {
  const src = fs.readFileSync(START_GUARD_SOURCE_PATH, "utf8");
  const fnMatch = src.match(/function canonicalLoomHome\([\s\S]*?\n\}/);
  if (!fnMatch) return false; // the function itself wasn't found — don't silently pass
  const body = fnMatch[0];
  return body.includes("fs.realpathSync.native(") && !/[^.]realpathSync\(existing\)/.test(body);
}

// Parses `cmd /c dir /x <parentDir>` output to find `leaf`'s 8.3 short alias, if the OS generated a
// distinct one. Returns the alias string, `null` if `leaf` was found but has NO distinct alias (8.3
// disabled on this volume, or the name already fits 8.3), or `undefined` if `leaf` wasn't found at all.
function shortAliasFor(parentDir, leaf) {
  const out = execFileSync("cmd.exe", ["/c", "dir", "/x", parentDir], { encoding: "utf8" });
  for (const line of out.split(/\r?\n/)) {
    const idx = line.indexOf("<DIR>");
    if (idx === -1) continue;
    const tokens = line.slice(idx + 5).trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || tokens[tokens.length - 1] !== leaf) continue;
    return tokens.length >= 2 ? tokens[0] : null;
  }
  return undefined;
}

if (process.platform !== "win32") {
  console.log(`[8dot3] off win32 (platform=${process.platform}) — no 8.3 short-name concept exists; falling back to the structural check.`);
  check("[8dot3:structural] canonicalLoomHome calls fs.realpathSync.native, not the plain fs.realpathSync", canonicalLoomHomeUsesRealpathNative());
} else {
  // A fresh, otherwise-empty container first: `os.tmpdir()` on a long-lived dev/CI host accumulates
  // thousands of stale entries from unrelated test runs (measured directly — `dir /x` against it
  // overflowed execFileSync's pipe buffer with ENOBUFS), so the long-named directory under test is
  // created one level DOWN, inside its own fresh container, keeping the `dir /x` listing to a handful
  // of entries.
  const container = mkdtempManaged("start-guard-8dot3-key-");
  const leaf = "LongDirectoryNameForTesting"; // well past 8 chars — forces a distinct 8.3 alias whenever
                                               // 8.3 generation is enabled on the host volume
  const longDir = path.join(container, leaf);
  fs.mkdirSync(longDir);
  const parent = container;
  const alias = shortAliasFor(parent, leaf);

  if (alias === undefined) {
    check("[8dot3] the freshly created temp dir was found by `dir /x` (if not, the parsing helper itself is broken)", false);
  } else if (alias === null) {
    console.log(`[8dot3] no distinct 8.3 alias was generated for ${leaf} — 8.3 name generation appears disabled on this volume. Falling back to the structural check per this card's own DoD.`);
    check("[8dot3:structural] canonicalLoomHome calls fs.realpathSync.native, not the plain fs.realpathSync", canonicalLoomHomeUsesRealpathNative());
  } else {
    const shortPath = path.join(parent, alias);
    console.log(`[8dot3] long form: ${longDir}`);
    console.log(`[8dot3] short form (OS-generated 8.3 alias): ${shortPath}`);
    check("[8dot3] precondition: the short alias actually resolves to the same real directory as the long form", fs.realpathSync.native(shortPath) === fs.realpathSync.native(longDir));

    const port = await reserveHermeticPort();

    const guardLong = await acquireStartGuard({ loomHome: longDir, port });
    check("[8dot3] launcher A acquires through the LONG spelling", guardLong.acquired === true);

    const guardShort = await acquireStartGuard({ loomHome: shortPath, port });
    check(
      "[8dot3] launcher B through the SHORT (8.3) spelling of the SAME real directory is REFUSED — same canonical key as A",
      expectExclusion ? guardShort.acquired === false && guardShort.code === "EADDRINUSE" : guardShort.acquired === true,
    );

    guardLong.release();
    if (guardShort.acquired) guardShort.release();

    // After A releases, a fresh attempt through the SHORT spelling must still acquire — confirming the
    // guard target itself is usable post-release through either spelling, not merely wedged open.
    const guardC = await acquireStartGuard({ loomHome: shortPath, port });
    check("[8dot3] after release, a fresh attempt through the short spelling acquires", guardC.acquired === true);
    guardC.release();
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — acquireStartGuard derives the SAME canonical key for a LOOM_HOME reached via its win32 8.3 short-name spelling as via its long form (or, where no live 8.3 scenario exists, the source is confirmed to use the native realpath binding that makes this true)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
