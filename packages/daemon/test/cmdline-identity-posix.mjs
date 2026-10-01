import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// Code Review round 4 (card 03cc6cae), item 2: POSIX `ps -p <pid> -o command=` does NOT quote its output
// at all, so a recorded `entry` containing a SPACE could never be found as a distinct argument via any
// naive whitespace split of that output — a real daemon launched from a space-containing path (a common
// real-world shape on macOS, e.g. "/Users/jane/Application Support/...") was refused by `loom
// stop`/`update`/`restart` (fail-safe, but broken). The fix: Linux reads `/proc/<pid>/cmdline` directly
// (exact, NUL-separated argv — no reconstruction needed at all); every other POSIX host (no `/proc`) still
// shells out to `ps`, but matches via a whole-ARGUMENT boundary on the raw string instead of any split.
//
// FUNCTION-LEVEL, not a real-process spawn: this host is win32 (see CLAUDE.md's isolated-daemon-testing
// notes — this suite runs on the owner's Windows host), so there is no live Linux `/proc` or POSIX `ps`
// to spawn a real stand-in against here. `cli-stop-pid-identity.mjs`/`cli-stop-cmdshim-separator.mjs`
// already cover the real win32 spawn path end to end; this file exercises the POSIX-shaped matching
// PRIMITIVES directly and hermetically, exactly as the kickoff asked for.
import { argvHasEntryArgument, cmdlineHasEntryArgumentBoundary, matchesRecordedEntry } from "../../../bin/lib/cmdline-identity.mjs";
import { finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// === Linux shape: exact NUL-separated argv (what /proc/<pid>/cmdline, split and filtered, produces) — ===
// === argvHasEntryArgument never needs to guess at boundaries since each element IS already one whole ====
// === argument, so a space-containing entry is matched exactly, with zero ambiguity. =======================
{
  const argv = ["node", "/opt/my app/dist/index.js", "--no-open"];
  check(
    "[linux-argv] a space-containing entry matches its own exact argv element",
    argvHasEntryArgument(argv, "/opt/my app/dist/index.js"),
  );
  check(
    "[linux-argv] a DIFFERENT path with the entry as a strict prefix does not match (exact equality, not substring)",
    !argvHasEntryArgument(["node", "/opt/my app/dist/index.jsx"], "/opt/my app/dist/index.js"),
  );
  check(
    "[linux-argv] an unrelated process whose SOME OTHER argument merely equals the entry still matches tier-1 (documented, not position-anchored — see isOurDaemon's own doc)",
    argvHasEntryArgument(["node", "other.js", "/opt/my app/dist/index.js"], "/opt/my app/dist/index.js"),
  );
  check(
    "[linux-argv] no element equals the entry at all → refused",
    !argvHasEntryArgument(["node", "/opt/unrelated/app.js"], "/opt/my app/dist/index.js"),
  );
}

// === Non-Linux POSIX shape: an UNQUOTED raw command-line STRING (what `ps -p <pid> -o command=` prints) =
// === — cmdlineHasEntryArgumentBoundary must find a space-containing entry at a real argument boundary, ===
// === and must NOT be fooled by a longer path that merely has the entry as a strict prefix. ===============
{
  const cmd = "node /opt/my app/dist/index.js --no-open";
  check(
    "[posix-boundary] a space-containing entry is found at a genuine whole-argument boundary in an unquoted raw command line",
    cmdlineHasEntryArgumentBoundary(cmd, "/opt/my app/dist/index.js"),
  );
  check(
    "[posix-boundary] negative control: a bogus entry that is NOT on the command line at all is refused (proves this check can fail)",
    !cmdlineHasEntryArgumentBoundary(cmd, "/opt/my app/dist/not-there.js"),
  );
  // THE PREFIX-COLLISION NEGATIVE (task-specified): entry="/a/b/index.js" must not match a command line
  // whose ONLY occurrence is a strictly LONGER path with that text as a prefix — no boundary immediately
  // follows the match in either case.
  check(
    "[posix-boundary] `/a/b/index.js` does NOT match a command line only containing `/a/b/index.jsx` (longer sibling, same prefix)",
    !cmdlineHasEntryArgumentBoundary("node /a/b/index.jsx --no-open", "/a/b/index.js"),
  );
  check(
    "[posix-boundary] `/a/b/index.js` does NOT match a command line only containing `/a/b/index.js.bak` (longer sibling, same prefix)",
    !cmdlineHasEntryArgumentBoundary("node /a/b/index.js.bak --no-open", "/a/b/index.js"),
  );
  // POSITIVE companion to the two negatives above, same corpus shape — proves the boundary check still
  // recognizes the genuine, non-colliding case (the exact path, not a longer sibling).
  check(
    "[posix-boundary] positive companion: `/a/b/index.js` DOES match a command line that actually names it (not a longer sibling)",
    cmdlineHasEntryArgumentBoundary("node /a/b/index.js --no-open", "/a/b/index.js"),
  );
  // Entry at the very START or END of the command line (no leading/trailing space to anchor against).
  check(
    "[posix-boundary] entry at the START of the command line (string-edge boundary, no leading space)",
    cmdlineHasEntryArgumentBoundary("/a/b/index.js --no-open", "/a/b/index.js"),
  );
  check(
    "[posix-boundary] entry at the END of the command line (string-edge boundary, no trailing space)",
    cmdlineHasEntryArgumentBoundary("node /a/b/index.js", "/a/b/index.js"),
  );
}

// === matchesRecordedEntry's own dispatch: argv present → exact match; argv absent but raw present → =====
// === boundary match; neither → refuse. Proves the TOP-LEVEL function callers actually use picks the ======
// === right strategy for each shape `commandLineOf` can hand it, not just the two primitives in isolation.=
{
  check(
    "[dispatch] argv present → dispatches to the exact per-token match",
    matchesRecordedEntry({ raw: "node /a/b/index.jsx", argv: ["node", "/a/b/index.jsx"] }, "/a/b/index.js") === false,
  );
  check(
    "[dispatch] raw-only (no argv) → dispatches to the boundary match, which still rejects a prefix collision",
    matchesRecordedEntry({ raw: "node /a/b/index.jsx", argv: null }, "/a/b/index.js") === false,
  );
  check(
    "[dispatch] raw-only (no argv), genuine boundary match → true",
    matchesRecordedEntry({ raw: "node /a/b/index.js --no-open", argv: null }, "/a/b/index.js") === true,
  );
  check(
    "[dispatch] neither raw nor argv (command line unreadable) → refused, never guesses",
    matchesRecordedEntry({ raw: null, argv: null }, "/a/b/index.js") === false,
  );
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the POSIX space-path identity match (Linux /proc/<pid>/cmdline exact argv, and a whole-argument boundary match for an unquoted `ps` raw string elsewhere on POSIX) finds a space-containing recorded `entry` correctly, and never mistakes a longer sibling path (a strict-prefix collision) for an exact match."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
