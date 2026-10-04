import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// Card 4e026f35 round 4 item 1(c): unit test for commandLineReferencesPath's path-boundary-aware match.
// A plain substring scan would wrongly match a LOOM_HOME that's a strict PREFIX of a sibling path (e.g.
// "...\.loom" inside "...\.loom-worktrees\..." — every worker's own worktree root) — see the decision
// record's "Test-suite process-scan notes" section for the full rationale.
// @decision 4e026f35
import { commandLineReferencesPath } from "./_process-scan.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const home = "C:\\Users\\x\\.loom";

// TRUE POSITIVE: home followed by a real boundary character.
check("[boundary] home followed by a backslash matches", commandLineReferencesPath(`node ${home}\\daemon.pid --flag`, home) === true);
check("[boundary] home followed by a forward slash matches", commandLineReferencesPath(`node ${home}/daemon.pid`, home) === true);
check("[boundary] home followed by a double quote matches", commandLineReferencesPath(`node "${home}"`, home) === true);
check("[boundary] home followed by a single quote matches", commandLineReferencesPath(`node '${home}'`, home) === true);
check("[boundary] home at the very end of the command line matches", commandLineReferencesPath(home, home) === true);
// @decision 4e026f35 — whitespace is a real argument boundary too (an unquoted `--flag value` shape); was
// NOT recognized before this case was added (RED on commit 89888d1c).
check("[boundary] home followed by a space (unquoted --home <home> --flag shape) matches", commandLineReferencesPath(`node x.js --home ${home} --flag`, home) === true);
check("[boundary] home followed by a tab matches", commandLineReferencesPath(`node x.js --home\t${home}\t--flag`, home) === true);
// @decision 4e026f35 — normalizeCmdlinePath collapses `\` vs `/` on both sides, so the SAME real
// directory referenced with forward slashes instead of the home's own backslashes still matches.
check(
  "[boundary] a forward-slash spelling of the same real path still matches (slash-collapse)",
  commandLineReferencesPath(`node x.js ${home.replace(/\\/g, "/")}/daemon.pid`, home) === true,
);

// FALSE POSITIVE AVOIDED: home is a strict prefix of a sibling path — the real-world "-worktrees" hazard.
check(
  "[boundary] home as a strict PREFIX of a sibling path (home + '-worktrees\\...') does NOT match",
  commandLineReferencesPath(`node ${home}-worktrees\\project\\repo\\index.js`, home) === false,
);
// A non-boundary occurrence earlier in the string must not short-circuit a real boundary match later on.
check(
  "[boundary] a non-boundary occurrence earlier in the string doesn't prevent a real boundary match later",
  commandLineReferencesPath(`node ${home}-worktrees\\x ${home}\\real\\path`, home) === true,
);
// No substring at all.
check("[boundary] no occurrence at all does NOT match", commandLineReferencesPath("node /unrelated/path/index.js", home) === false);
// An empty pathSubstring never matches anything.
check("[boundary] an empty pathSubstring never matches", commandLineReferencesPath("anything at all", "") === false);

if (process.platform === "win32") {
  check("[boundary] win32: case-insensitive match", commandLineReferencesPath(`node ${home.toUpperCase()}\\daemon.pid`, home) === true);
} else {
  check("[boundary] POSIX: case-sensitive — a differently-cased path does NOT match", commandLineReferencesPath(`node ${home.toUpperCase()}/daemon.pid`, home) === false);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — commandLineReferencesPath requires a real path boundary (separator/quote/end-of-string) after the matched substring, rejecting a strict-prefix sibling path like '<home>-worktrees'."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
