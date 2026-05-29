// encodeProjectDir test (R1 fix). Deterministic, no daemon/claude. Asserts loom's project-dir
// encoding matches Claude's REAL on-disk encoding (verified against ~/.claude/projects): every
// non-alphanumeric char in the resolved cwd becomes '-'. The pre-fix version only replaced `:\/`,
// so a cwd with a `.` (e.g. a worktree under ~/.loom) or `_` (e.g. immo_trend) computed the wrong
// dir and transcript reads silently returned nothing (R1 / audit L3). Run: node test/transcript-encode.mjs
import path from "node:path";
import { encodeProjectDir } from "../dist/sessions/transcript.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Each char that isn't [a-zA-Z0-9] → '-' (matches observed Claude dirs like
// C--Users-danie-AppData-Local-Temp-claude-tmp-as4TmS96wx-... and ...-immo-trend-data).
const expect = (cwd) => path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");

// The R1 bug: a DOT in the path (a real ~/.loom worktree, or a mktemp `tmp.xxxx`) must encode to '-'.
{
  const dotted = path.resolve("/tmp/tmp.as4TmS96wx/worktrees/p/abcd1234");
  const enc = encodeProjectDir(dotted);
  check("dotted path: every '.' becomes '-'", !enc.includes(".") && enc === expect(dotted));
}
// Underscores too (e.g. the immo_trend repo) — confirmed by C--...-immo-trend-data on disk.
{
  const under = path.resolve("/home/u/immo_trend_data");
  const enc = encodeProjectDir(under);
  check("underscored path: every '_' becomes '-'", !enc.includes("_") && enc === expect(under));
}
// Mixed separators + the canonical `.loom` worktree shape.
{
  const loomWt = path.resolve(process.env.HOME || "/h", ".loom/worktrees/proj/feat");
  const enc = encodeProjectDir(loomWt);
  check(".loom worktree: leading-dot segment encodes (no '.' survives)", !enc.includes(".") && enc === expect(loomWt));
}
// Alphanumerics and the resulting hyphens are preserved (idempotent on a clean key).
{
  const enc = encodeProjectDir(path.resolve("/a/b1/c2"));
  check("alnum segments preserved", /^[-A-Za-z0-9]+$/.test(enc) && enc.includes("b1") && enc.includes("c2"));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — encodeProjectDir replaces every non-alphanumeric (incl. '.' and '_') with '-', matching Claude's on-disk project-dir encoding (R1 fix)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
