// comment-anchor-lint.mjs PER-FILE hook test (card 67621894 — wires the whole-repo report tool from card
// 5329a9af as a live PostToolUse hook, scoped to just the file a Write/Edit just touched). Three halves:
//   1. The pure per-file functions (`isInScope`/`computeFileReport`/`formatHookMessage`) against a fixture
//      repo, plus a real subprocess spawn of the script's own `--hook` mode (no build needed for either —
//      same "assets are plain ESM" posture as test/comment-anchor-lint.mjs).
//   2. `extractWrittenText`/`scopeHookPointerAnchors` (card a862e8f0 lead review, round 2): the hook's
//      `pointerAnchors` advisory used to dump EVERY pre-existing pointer anchor in the edited file on
//      every single edit (measured up to 197 sites in one real file) — these two functions scope that
//      down to the site(s) the triggering Edit/Write/MultiEdit actually just wrote, with a hard cap
//      (`HOOK_POINTER_ANCHOR_CAP`) as a belt-and-suspenders bound. Tested both as pure functions and via
//      a real subprocess spawn against a fixture file carrying many pre-existing pointer anchors, proving
//      the hook's OUTPUT stays bounded and a newly-written pointer anchor is still caught while untouched
//      pre-existing ones are not.
//   2b. `scopeHookAnchorSites` (card 5e5841dd): `scopeHookPointerAnchors`'s scoper generalized to also
//      cover `overlongAnchorParagraphs`/`midSentenceAnchors` — the SAME flood risk (a main-tree baseline
//      of 257/155, concentrated in the same giant files pointerAnchors already floods on) would otherwise
//      apply to those two fields going into the hook unscoped. A real subprocess spawn against a fixture
//      file carrying several pre-existing overlong/mid-sentence anchors proves an Edit touching ONE
//      reports only that one, and an Edit touching none reports neither field's section at all.
//   2c. `embeddedAnchors`/`splitAnchorParagraphs` HOOK scoping (card a873621e): the SAME
//      `scopeHookAnchorSites` mechanism applied to the two newest checks — an Edit touching one
//      pre-existing site of either shape surfaces only that site, and an Edit touching neither omits
//      both fields' sections entirely.
//   3. writeSessionSettings' wiring: card d92ec82b reworked this gate — the hook now wires on the EXPLICIT
//      `docLint` param AND requires `repoPath`, independently of `vaultPath` (vault-lint's own, separate
//      gate) — so a project with docLint on but no Obsidian vault still gets it. Imported from
//      `../dist/pty/claude-settings.js`, so THIS half needs a build first (`pnpm --filter @loom/daemon
//      build`), same as test/vault-lint.mjs.
//
// RUN with an isolated LOOM_HOME (no daemon needed — writeSessionSettings just needs the settings dir):
//   LOOM_HOME=<temp> node test/comment-anchor-lint-hook.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  isInScope,
  computeFileReport,
  formatHookMessage,
  extractWrittenText,
  scopeHookPointerAnchors,
  scopeHookAnchorSites,
  HOOK_POINTER_ANCHOR_CAP,
} from "../assets/comment-anchor-lint.mjs";

if (!process.env.LOOM_HOME) { console.error("LOOM_HOME must be set."); process.exit(2); }

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { SETTINGS_DIR, ensureDirs, COMMENT_ANCHOR_LINT_SCRIPT } = await import("../dist/paths.js");
const { writeSessionSettings } = await import("../dist/pty/claude-settings.js");

// --- fixture repo: one file WITH violations, one CLEAN file, a docs store, a test/-excluded file --------
const REPO = path.join(os.tmpdir(), `loom-comment-anchor-lint-hook-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(REPO, "packages", "daemon", "src"), { recursive: true });
fs.mkdirSync(path.join(REPO, "packages", "daemon", "test"), { recursive: true });
fs.mkdirSync(path.join(REPO, "docs", "adr"), { recursive: true });

// aaaaaaaa: anchored + recorded → clean. dddddddd: anchored, NOTHING resolves it → orphan anchor.
const longUnanchored = Array.from({ length: 20 }, (_, i) => `// regrowing narrative line ${i}`).join("\n");
const violatingSrc = [
  "const before = 1;",
  "",
  "// @decision dddddddd — resolves to nothing, must be flagged as an orphan anchor",
  "",
  longUnanchored,
  "",
  "const after = 1;",
].join("\n");
const cleanSrc = [
  "const before = 1;",
  "",
  "// @decision aaaaaaaa — resolved via docs/adr, never flagged",
  "",
  "const after = 1;",
].join("\n");
const violatingPath = path.join(REPO, "packages", "daemon", "src", "violating.ts");
const cleanPath = path.join(REPO, "packages", "daemon", "src", "clean.ts");
const excludedPath = path.join(REPO, "packages", "daemon", "test", "fixture-test.mjs");
const wrongExtPath = path.join(REPO, "packages", "daemon", "src", "notes.md");
fs.writeFileSync(violatingPath, violatingSrc);
fs.writeFileSync(cleanPath, cleanSrc);
fs.writeFileSync(excludedPath, "// @decision ffffffff — synthetic test-fixture anchor, must never be scanned\n");
fs.writeFileSync(wrongExtPath, "# not a source file\n");
fs.writeFileSync(path.join(REPO, "docs", "adr", "aaaaaaaa-example.md"), "# aaaaaaaa\n\nAn ADR.\n");

try {
  // --- isInScope -----------------------------------------------------------------------------------
  check("isInScope: an in-scope source file resolves to its repo-relative path",
    isInScope(REPO, violatingPath) === "packages/daemon/src/violating.ts");
  check("isInScope: a file under an excluded segment (test/) is rejected", isInScope(REPO, excludedPath) === null);
  check("isInScope: a non-source extension (.md) is rejected", isInScope(REPO, wrongExtPath) === null);
  check("isInScope: a path outside repoRoot entirely is rejected",
    isInScope(REPO, path.join(os.tmpdir(), "elsewhere.ts")) === null);
  // card 03fbb126: scope is layout-AGNOSTIC — a non-Loom layout is in scope; hidden/build dirs still are not.
  check("isInScope (03fbb126): a non-Loom layout (lib/x.js at the repo root) IS in scope",
    isInScope(REPO, path.join(REPO, "lib", "x.js")) === "lib/x.js");
  check("isInScope (03fbb126): a former not-in-SOURCE_ROOTS path is now in scope",
    isInScope(REPO, path.join(REPO, "packages", "daemon", "notsrc", "x.ts")) === "packages/daemon/notsrc/x.ts");
  check("isInScope (03fbb126): src/docs/thing.ts (a NESTED docs dir) IS in scope",
    isInScope(REPO, path.join(REPO, "src", "docs", "thing.ts")) === "src/docs/thing.ts");
  check("isInScope (03fbb126): repo-ROOT docs/investigations/x/scripts/y.mjs is NOT in scope",
    isInScope(REPO, path.join(REPO, "docs", "investigations", "x", "scripts", "y.mjs")) === null);
  check("isInScope (03fbb126): a hidden directory (.claude/skills) is rejected",
    isInScope(REPO, path.join(REPO, ".claude", "skills", "x.mjs")) === null);
  check("isInScope (03fbb126): a build-output directory (dist/) is rejected",
    isInScope(REPO, path.join(REPO, "dist", "x.js")) === null);

  // --- computeFileReport: positive control (must be able to SEE a violation) -----------------------
  const violatingReport = computeFileReport(REPO, violatingPath, violatingSrc, { minLines: 15 });
  check("computeFileReport: in-scope violating file is not null", violatingReport !== null);
  check("computeFileReport: the 20-line unanchored block is flagged",
    violatingReport.unanchoredLongBlocks.length === 1 && violatingReport.unanchoredLongBlocks[0].length === 20);
  check("computeFileReport: dddddddd is flagged as an orphan anchor",
    violatingReport.orphanAnchors.length === 1 && violatingReport.orphanAnchors[0].id === "dddddddd");

  // --- computeFileReport: negative control (a genuinely clean in-scope file reports nothing) --------
  const cleanReport = computeFileReport(REPO, cleanPath, cleanSrc, { minLines: 15 });
  check("computeFileReport: in-scope clean file is not null (was actually scanned, not skipped)", cleanReport !== null);
  check("computeFileReport: clean file has zero unanchoredLongBlocks", cleanReport.unanchoredLongBlocks.length === 0);
  check("computeFileReport: clean file has zero orphanAnchors (aaaaaaaa resolves via docs/adr)",
    cleanReport.orphanAnchors.length === 0);

  // --- computeFileReport: out-of-scope file returns null, not an empty report (distinguishable) -----
  check("computeFileReport: out-of-scope file (test/) returns null, not a zeroed report",
    computeFileReport(REPO, excludedPath, "// @decision ffffffff — x\n") === null);

  // --- formatHookMessage ------------------------------------------------------------------------------
  const msg = formatHookMessage(violatingReport);
  check("formatHookMessage: names the file", msg.includes("packages/daemon/src/violating.ts"));
  check("formatHookMessage: names the orphan anchor id", msg.includes("dddddddd"));
  check("formatHookMessage: names the unanchored block's line length", msg.includes("20 lines"));

  // --- runHook via a real subprocess spawn (`node comment-anchor-lint.mjs --hook <repoRoot>`) -------
  const runHookProc = (filePath, tool = "Write") => {
    const payload = { hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: filePath }, cwd: REPO };
    const r = spawnSync(process.execPath, [COMMENT_ANCHOR_LINT_SCRIPT, "--hook", REPO], { input: JSON.stringify(payload), encoding: "utf8" });
    check(`runHook(${tool} ${path.basename(filePath)}): exits 0 (warn-only, never blocks)`, r.status === 0);
    const out = (r.stdout || "").trim();
    return out ? JSON.parse(out) : null;
  };

  // POSITIVE CONTROL FIRST (DoD-4): prove the hook can actually see a violation before trusting silence.
  const hit = runHookProc(violatingPath, "Write");
  check("runHook (positive control): a Write on the violating file DOES fire", hit !== null);
  check("runHook (positive control): additionalContext carries the orphan anchor id",
    !!hit && /dddddddd/.test(hit.hookSpecificOutput?.additionalContext ?? ""));
  check("runHook (positive control): hookSpecificOutput.hookEventName === PostToolUse",
    !!hit && hit.hookSpecificOutput?.hookEventName === "PostToolUse");

  // card 9b293b4b regression: the payload carries no systemMessage copy — additionalContext only
  // (mirrors decision-records.mjs's own card da723d41 regression; see the asset's header for why).
  check("card 9b293b4b: the payload carries NO systemMessage field at all", !!hit && !("systemMessage" in hit));
  check("card 9b293b4b: hookSpecificOutput.additionalContext is the ONLY top-level key",
    !!hit && Object.keys(hit).length === 1 && Object.keys(hit)[0] === "hookSpecificOutput");

  // NEGATIVE CONTROLS — each isolates ONE reason the hook should stay silent.
  check("runHook (negative control): a Write on a CLEAN in-scope file stays silent", runHookProc(cleanPath, "Write") === null);
  check("runHook (negative control): a Read (wrong tool) on the SAME violating file stays silent", runHookProc(violatingPath, "Read") === null);
  check("runHook (negative control): a Write on an out-of-scope file (test/) stays silent", runHookProc(excludedPath, "Write") === null);
  check("runHook (negative control): a Write on a non-source extension stays silent", runHookProc(wrongExtPath, "Write") === null);
  {
    const r = spawnSync(process.execPath, [COMMENT_ANCHOR_LINT_SCRIPT, "--hook"], { input: "{}", encoding: "utf8" });
    check("runHook (negative control): missing repoRoot arg exits 0 and stays silent", r.status === 0 && !(r.stdout || "").trim());
  }

  // --- card 03fbb126: the hook fires on a NON-Loom layout, and resolves docs/ at the nearest .git root ---
  {
    const NL = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cal-nonloom-"));
    fs.mkdirSync(path.join(NL, ".git"), { recursive: true });
    fs.mkdirSync(path.join(NL, "docs", "decisions"), { recursive: true });
    fs.mkdirSync(path.join(NL, "app", "lib"), { recursive: true });
    fs.writeFileSync(path.join(NL, "docs", "decisions", "eeeeeeee-real.md"), "# eeeeeeee\n\nA record.\n");
    const srcPath = path.join(NL, "app", "lib", "thing.js");
    fs.writeFileSync(srcPath, [
      "// @decision eeeeeeee — resolves at the git root's docs/decisions, must NOT be an orphan",
      "// @decision 99999999 — resolves to nothing, MUST be flagged as an orphan",
      "const x = 1;",
    ].join("\n"));
    try {
      const run = (rootArg) => {
        const payload = { tool_name: "Write", tool_input: { file_path: srcPath }, cwd: NL };
        const r = spawnSync(process.execPath, [COMMENT_ANCHOR_LINT_SCRIPT, "--hook", rootArg], { input: JSON.stringify(payload), encoding: "utf8" });
        const out = (r.stdout || "").trim();
        return out ? JSON.parse(out).hookSpecificOutput.additionalContext : null;
      };
      // hook arg = the project SUBFOLDER (cwd below the git root), the nested-repo shape of card a4760fc8
      const viaSub = run(path.join(NL, "app"));
      check("hook (03fbb126, non-Loom layout, nested cwd): fires and flags the truly-orphan anchor",
        !!viaSub && /99999999/.test(viaSub));
      check("hook (03fbb126, nested cwd): docs/ resolved at the .git root, so the recorded anchor is NOT an orphan",
        !!viaSub && !/eeeeeeee/.test(viaSub));
      const viaRoot = run(NL);
      check("hook (03fbb126): same result when the hook arg IS the git root",
        !!viaRoot && /99999999/.test(viaRoot) && !/eeeeeeee/.test(viaRoot));
    } finally {
      try { fs.rmSync(NL, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // --- extractWrittenText (card a862e8f0 round 2): pure-function coverage of the Write/Edit/MultiEdit -----
  // tool_input shapes this hook's own harness (Claude Code) actually invokes these tools with.
  {
    check("extractWrittenText: Write carries tool_input.content",
      extractWrittenText("Write", { file_path: "/x", content: "the whole file" }) === "the whole file");
    check("extractWrittenText: Edit carries tool_input.new_string",
      extractWrittenText("Edit", { file_path: "/x", old_string: "a", new_string: "the replacement" }) === "the replacement");
    check("extractWrittenText: MultiEdit joins every edit's new_string",
      extractWrittenText("MultiEdit", { file_path: "/x", edits: [{ new_string: "first" }, { new_string: "second" }] }) === "first\nsecond");
    check("extractWrittenText: MultiEdit with an empty edits array returns null (nothing to join)",
      extractWrittenText("MultiEdit", { file_path: "/x", edits: [] }) === null);
    check("extractWrittenText: an unrecognized tool name returns null",
      extractWrittenText("Read", { file_path: "/x" }) === null);
    check("extractWrittenText: Edit missing new_string entirely returns null (never guesses)",
      extractWrittenText("Edit", { file_path: "/x", old_string: "a" }) === null);
    check("extractWrittenText: a non-object tool_input returns null rather than throwing",
      extractWrittenText("Edit", null) === null && extractWrittenText("Edit", undefined) === null);
  }

  // --- scopeHookPointerAnchors (card a862e8f0 round 2): pure-function coverage -----------------------------
  {
    const pointerAnchors = [
      { line: 1, id: "aaaaaaaa", ns: "card", phrase: "see docs/" },
      { line: 3, id: "bbbbbbbb", ns: "card", phrase: "docs/decisions/" },
      { line: 5, id: "cccccccc", ns: "card", phrase: "see the record" },
    ];
    const lines = [
      "// @decision aaaaaaaa — see docs/decisions/aaaaaaaa-x.md, pre-existing site one",
      "",
      "// @decision bbbbbbbb — the reasoning is at docs/decisions/bbbbbbbb-x.md, pre-existing site two",
      "",
      "// @decision cccccccc — see the record for the full story, pre-existing site three",
    ];

    // Positive control (DoD): only the site whose OWN anchor line is a substring of `writtenText` is kept.
    const writtenOne = "some unrelated diff context\n// @decision bbbbbbbb — the reasoning is at docs/decisions/bbbbbbbb-x.md, pre-existing site two\nmore context";
    const scopedOne = scopeHookPointerAnchors(pointerAnchors, lines, writtenOne);
    check("scopeHookPointerAnchors: only the site whose anchor line appears in writtenText is kept",
      scopedOne.items.length === 1 && scopedOne.items[0].id === "bbbbbbbb" && scopedOne.omitted === 0);

    // Negative control: writtenText containing NONE of the anchor lines keeps nothing.
    const scopedNone = scopeHookPointerAnchors(pointerAnchors, lines, "completely unrelated text, no anchor here at all");
    check("scopeHookPointerAnchors: writtenText matching no anchor line keeps nothing",
      scopedNone.items.length === 0 && scopedNone.omitted === 0);

    // writtenText === null (payload shape unrecognized): falls back to a CAPPED, unscoped slice — never
    // flood, never silently drop everything either.
    const manyAnchors = Array.from({ length: HOOK_POINTER_ANCHOR_CAP + 3 }, (_, i) => ({ line: i + 1, id: `id${i}`.padEnd(8, "0"), ns: "card", phrase: "see docs/" }));
    const scopedNull = scopeHookPointerAnchors(manyAnchors, [], null);
    check("scopeHookPointerAnchors: writtenText===null falls back to a CAPPED slice of the full list",
      scopedNull.items.length === HOOK_POINTER_ANCHOR_CAP && scopedNull.omitted === 3);

    // The cap applies even to genuinely-scoped (all just-written) candidates — the belt-and-suspenders
    // bound documented on HOOK_POINTER_ANCHOR_CAP, not just the null-fallback path. Build a writtenText
    // that contains every one of manyAnchors' own anchor LINE text (re-derive the same lines array
    // `scopeHookPointerAnchors` will read against, so the containment test is self-consistent).
    const manyLines = manyAnchors.map((a) => `// @decision ${a.id} — see docs/decisions/${a.id}-x.md`);
    const manyAnchorsRealigned = manyAnchors.map((a, i) => ({ ...a, line: i + 1 }));
    const writtenAll = manyLines.join("\n");
    const scopedCapped = scopeHookPointerAnchors(manyAnchorsRealigned, manyLines, writtenAll);
    check("scopeHookPointerAnchors: the cap trims even fully-scoped (all just-written) candidates",
      scopedCapped.items.length === HOOK_POINTER_ANCHOR_CAP && scopedCapped.omitted === 3);
  }

  // --- end-to-end: a real subprocess spawn against a fixture file carrying MANY pre-existing pointer -------
  // anchors, proving the hook's actual advisory text stays bounded (card a862e8f0 round 2, the exact
  // complaint: "sessions/service.ts 197, pty/host.ts 71, ... ~200 lines of PRE-EXISTING findings per edit").
  {
    const manyDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pointer-scope-hook-"));
    try {
      fs.mkdirSync(path.join(manyDir, "packages", "daemon", "src"), { recursive: true });
      const N = 8; // well above HOOK_POINTER_ANCHOR_CAP (5), so the pre-existing set alone would overflow it
      const preExisting = Array.from({ length: N }, (_, i) => `// @decision aaaaaaa${i} — see docs/decisions/aaaaaaa${i}-x.md, pre-existing site ${i}`);
      // NOTE: the id must be REAL 8-hex ([0-9a-f]) — ANCHOR_RE requires it, so a non-hex id like
      // "newnew01" is silently NOT an anchor at all (this bit the first draft of this test: the "newly
      // written" site never appeared anywhere in the report because it was never recognized as an anchor).
      const newlyWrittenLine = "// @decision deadc0de — see docs/decisions/deadc0de-x.md, the site this edit just added";
      const manyPath = path.join(manyDir, "packages", "daemon", "src", "many.ts");
      fs.writeFileSync(manyPath, [...preExisting, "", newlyWrittenLine, ""].join("\n"));

      const runHookProcInput = (filePath, tool, toolInput) => {
        const payload = { hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: filePath, ...toolInput }, cwd: manyDir };
        const r = spawnSync(process.execPath, [COMMENT_ANCHOR_LINT_SCRIPT, "--hook", manyDir], { input: JSON.stringify(payload), encoding: "utf8" });
        check(`runHook(${tool} ${path.basename(filePath)}, scoped): exits 0`, r.status === 0);
        const out = (r.stdout || "").trim();
        return out ? JSON.parse(out) : null;
      };

      // The Edit's own new_string is EXACTLY the newly-written line — this is what a real Edit call
      // carries (the replacement text), so this is the realistic shape, not a synthetic shortcut.
      const scopedHit = runHookProcInput(manyPath, "Edit", { old_string: "placeholder", new_string: newlyWrittenLine });
      const scopedMsg = scopedHit?.hookSpecificOutput?.additionalContext ?? "";
      check("hook (scoped Edit): fires (the newly-written pointer anchor IS flagged)", scopedHit !== null);
      check("hook (scoped Edit): names the newly-written anchor's id", /deadc0de/.test(scopedMsg));
      // NOTE: orphanAnchors is a SEPARATE, unscoped check (this fixup only scopes pointerAnchors — see
      // the card) — it legitimately still lists all 9 ids (none have a matching record file), so testing
      // "not anywhere in scopedMsg" would wrongly fail on that unrelated section. Pointer-anchor entries
      // are the only ones rendered with a "(matched ...)" suffix — scope the assertion to those.
      check("hook (scoped Edit): does NOT name any of the 8 pre-existing anchor ids as a pointer-anchor finding",
        !/aaaaaaa[0-7] \(matched/.test(scopedMsg));
      check("hook (scoped Edit): the pointer-anchor count in the message is exactly 1, not 9",
        /^1 @decision anchor\(s\)/m.test(scopedMsg));

      // Unknown/unrecognized tool_input shape (no new_string, no content, no edits) — falls back to the
      // CAPPED, unscoped slice rather than either flooding (all 9) or going silent (0).
      const fallbackHit = runHookProcInput(manyPath, "Edit", { unexpected_field: true });
      const fallbackMsg = fallbackHit?.hookSpecificOutput?.additionalContext ?? "";
      check("hook (unrecognized tool_input shape): still fires (never silently drops a real finding)", fallbackHit !== null);
      check(`hook (unrecognized tool_input shape): pointer-anchor count is capped at ${HOOK_POINTER_ANCHOR_CAP}, not 9`,
        new RegExp(`^${HOOK_POINTER_ANCHOR_CAP} @decision anchor\\(s\\)`, "m").test(fallbackMsg));
      check("hook (unrecognized tool_input shape): the omitted-count note names how many more exist",
        /\(4 more pointer-anchor site\(s\)/.test(fallbackMsg));

      // A Write of a BRAND-NEW file where content IS the entire file (every anchor genuinely "just
      // written") — scoping correctly keeps ALL of them (still capped, since the cap is unconditional),
      // unlike a full-rewrite-of-an-existing-file case this program's own convention discourages.
      // The hook ALWAYS re-reads the file from disk (never trusts tool_input.content as the file's
      // actual state) — so the fixture must genuinely be written to disk first, exactly like a real
      // Write tool call would leave it, or runHook's `fs.readFileSync` silently no-ops (file not found).
      const freshPath = path.join(manyDir, "packages", "daemon", "src", "fresh.ts");
      const freshContent = preExisting.join("\n") + "\n";
      fs.writeFileSync(freshPath, freshContent);
      const freshHit = runHookProcInput(freshPath, "Write", { content: freshContent });
      const freshMsg = freshHit?.hookSpecificOutput?.additionalContext ?? "";
      check("hook (Write, brand-new file, all genuinely new): still capped at HOOK_POINTER_ANCHOR_CAP, not flooded to 8",
        freshHit !== null && new RegExp(`^${HOOK_POINTER_ANCHOR_CAP} @decision anchor\\(s\\)`, "m").test(freshMsg));
    } finally {
      try { fs.rmSync(manyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // --- scopeHookAnchorSites (card 5e5841dd): generalized pure-function coverage ---------------------------
  {
    const overlongSites = [
      { line: 1, id: "aaaaaaaa", ns: "card", length: 6 },
      { line: 8, id: "bbbbbbbb", ns: "card", length: 5 },
    ];
    const overlongLines = [
      "// @decision aaaaaaaa — line 1 of a pre-existing overlong paragraph, site one",
      "// line 2", "// line 3", "// line 4", "// line 5", "// line 6, still site one",
      "",
      "// @decision bbbbbbbb — line 1 of a pre-existing overlong paragraph, site two",
    ];
    // Same substring-containment mechanism as scopeHookPointerAnchors — proven generic here by feeding it
    // overlongAnchorParagraphs-shaped items instead of pointerAnchors-shaped ones.
    const scopedOne = scopeHookAnchorSites(overlongSites, overlongLines, overlongLines[7]);
    check("scopeHookAnchorSites: only the site whose anchor line appears in writtenText is kept (generalized)",
      scopedOne.items.length === 1 && scopedOne.items[0].id === "bbbbbbbb" && scopedOne.omitted === 0);
    const scopedNone = scopeHookAnchorSites(overlongSites, overlongLines, "unrelated text");
    check("scopeHookAnchorSites: writtenText matching no anchor line keeps nothing (generalized)",
      scopedNone.items.length === 0);
    // A custom cap (never just the pointerAnchors-specific HOOK_POINTER_ANCHOR_CAP default) is honored.
    const scopedCapped = scopeHookAnchorSites(overlongSites, overlongLines, null, 1);
    check("scopeHookAnchorSites: a custom cap is honored (not hardcoded to HOOK_POINTER_ANCHOR_CAP)",
      scopedCapped.items.length === 1 && scopedCapped.omitted === 1);
  }

  // --- overlongAnchorParagraphs / midSentenceAnchors HOOK scoping (card 5e5841dd) ---------------------------
  // Mirrors the pointerAnchors flood fix above (card a862e8f0 round 2), generalized (card 5e5841dd) rather
  // than a second bespoke scoper: a file already carrying several pre-existing overlong/mid-sentence
  // anchors must not flood the advisory on every edit — only the site(s) the triggering edit actually wrote.
  {
    const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-overlong-mid-scope-hook-"));
    try {
      fs.mkdirSync(path.join(scopeDir, "packages", "daemon", "src"), { recursive: true });
      const overlongBlock = (id) => [
        `// @decision ${id} — line 1 of a paragraph that runs on far too long for a guard-class anchor,`,
        `// line 2, still narrating for id ${id},`,
        `// line 3, past the guard cap already for ${id},`,
        `// line 4, the actual prohibition for ${id} finally lands here.`,
      ];
      const midSentenceLine = (id) => `// some narrative text first, then (@decision ${id}) buried inline`;
      const preExisting = [
        ...overlongBlock("aaaaaaa0"),
        "",
        ...overlongBlock("aaaaaaa1"),
        "",
        ...overlongBlock("aaaaaaa2"),
        "",
        midSentenceLine("aaaaaaa3"),
        "",
      ];
      const newlyWrittenOverlong = overlongBlock("deadc0de"); // the site this edit "just wrote"
      const scopePath = path.join(scopeDir, "packages", "daemon", "src", "scope.ts");
      fs.writeFileSync(scopePath, [...preExisting, ...newlyWrittenOverlong, ""].join("\n"));

      const runHookProc = (filePath, tool, toolInput) => {
        const payload = { hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: filePath, ...toolInput }, cwd: scopeDir };
        const r = spawnSync(process.execPath, [COMMENT_ANCHOR_LINT_SCRIPT, "--hook", scopeDir], { input: JSON.stringify(payload), encoding: "utf8" });
        check(`runHook(${tool} ${path.basename(filePath)}, overlong/mid scoping): exits 0`, r.status === 0);
        const out = (r.stdout || "").trim();
        return out ? JSON.parse(out) : null;
      };

      // The Edit's new_string is EXACTLY the newly-written overlong paragraph (all 4 lines) — only THAT
      // anchor's paragraph must be surfaced, none of the 3 pre-existing overlong/mid-sentence sites.
      const scopedHit = runHookProc(scopePath, "Edit", { old_string: "placeholder", new_string: newlyWrittenOverlong.join("\n") });
      const scopedMsg = scopedHit?.hookSpecificOutput?.additionalContext ?? "";
      check("hook (Edit touching ONE overlong anchor): fires", scopedHit !== null);
      check("hook (Edit touching ONE overlong anchor): the overlong-anchor-paragraph count is exactly 1, not 4",
        /^1 over-long @decision anchor paragraph\(s\)/m.test(scopedMsg));
      check("hook (Edit touching ONE overlong anchor): names ONLY the newly-written id, none of the 3 pre-existing",
        /deadc0de \(4 lines\)/.test(scopedMsg) && !/aaaaaaa0 \(4 lines\)/.test(scopedMsg)
        && !/aaaaaaa1 \(4 lines\)/.test(scopedMsg) && !/aaaaaaa2 \(4 lines\)/.test(scopedMsg));
      // NOTE: orphanAnchors is a SEPARATE, unscoped check (same caveat as the pointerAnchors test above) —
      // it legitimately still lists aaaaaaa3 (no matching record), so "not anywhere in scopedMsg" would
      // wrongly fail on that unrelated section. Scope this assertion to the mid-sentence section itself.
      check("hook (Edit touching ONE overlong anchor): the pre-existing mid-sentence anchor's OWN section is absent",
        !/mid-sentence @decision anchor\(s\)/.test(scopedMsg));

      // An Edit touching NONE of the overlong-paragraph/mid-sentence sites (an unrelated one-liner
      // elsewhere in the file) — neither field's section appears at all. (orphanAnchors, a SEPARATE
      // unscoped check, legitimately still fires since none of these ids have a matching record — that's
      // expected and irrelevant to this assertion, which is scoped to the two fields under test.)
      const noneHit = runHookProc(scopePath, "Edit", { old_string: "placeholder", new_string: "// a completely unrelated one-line comment, touches nothing" });
      const noneMsg = noneHit?.hookSpecificOutput?.additionalContext ?? "";
      check("hook (Edit touching none of the overlong/mid-sentence sites): no overlong-anchor-paragraph section at all",
        !/over-long @decision anchor paragraph/.test(noneMsg));
      check("hook (Edit touching none of the overlong/mid-sentence sites): no mid-sentence-anchor section at all",
        !/mid-sentence @decision anchor/.test(noneMsg));
    } finally {
      try { fs.rmSync(scopeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // --- embeddedAnchors / splitAnchorParagraphs HOOK scoping (card a873621e) --------------------------------
  // Same flood-prevention mechanism as the overlongAnchorParagraphs/midSentenceAnchors block above, for the
  // two NEW checks this card adds — a file already carrying several pre-existing embedded/split sites must
  // not flood the advisory on every edit; only the site(s) the triggering edit actually wrote.
  {
    const scopeDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "loom-embedded-split-scope-hook-"));
    try {
      fs.mkdirSync(path.join(scopeDir2, "packages", "daemon", "src"), { recursive: true });
      // embeddedAnchors shape: the anchor opens its own line, but the PRECEDING line doesn't end a
      // sentence — real specimen shape (host.ts ac90ca8e/3388be4d), parameterized by id.
      const embeddedPair = (prevId, id) => [
        `/** @decision ${prevId} — role-scoped transcript-root deny (extended by 44fa586a; moved to this chokepoint by`,
        ` * @decision ${id}): closes the native Read/Glob/Grep bypass of the MCP-mediated read gates; keyed off`,
        ` * the PINNED opts.role, UNIONed into .deny (never replaces); run is deliberately excluded.`,
        ` */`,
      ];
      // splitAnchorParagraphs shape: a blank comment line forces the paragraph short before the sentence
      // ends — real specimen shape (round-1's reverted host.ts fix), parameterized by id.
      const splitPair = (id, tailId) => [
        `/** @decision ${id} — role-scoped transcript-root deny (extended by 44fa586a; moved to this chokepoint`,
        ` * by`,
        ` *`,
        ` * @decision ${tailId}): closes the native Read/Glob/Grep bypass of the MCP-mediated read gates; keyed off`,
        ` */`,
      ];
      const preExisting = [
        ...embeddedPair("aaaaaaa0", "aaaaaaa1"),
        "",
        ...splitPair("aaaaaaa2", "aaaaaaa3"),
        "",
      ];
      const newlyWrittenEmbedded = embeddedPair("deadc0d0", "deadc0d1"); // the site this edit "just wrote"
      const scopePath2 = path.join(scopeDir2, "packages", "daemon", "src", "scope2.ts");
      fs.writeFileSync(scopePath2, [...preExisting, ...newlyWrittenEmbedded, ""].join("\n"));

      const runHookProc2 = (filePath, tool, toolInput) => {
        const payload = { hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: filePath, ...toolInput }, cwd: scopeDir2 };
        const r = spawnSync(process.execPath, [COMMENT_ANCHOR_LINT_SCRIPT, "--hook", scopeDir2], { input: JSON.stringify(payload), encoding: "utf8" });
        check(`runHook(${tool} ${path.basename(filePath)}, embedded/split scoping): exits 0`, r.status === 0);
        const out = (r.stdout || "").trim();
        return out ? JSON.parse(out) : null;
      };

      // The Edit's new_string is EXACTLY the newly-written embedded-anchor pair — only THAT site must be
      // surfaced, none of the pre-existing embedded/split sites.
      const scopedHit2 = runHookProc2(scopePath2, "Edit", { old_string: "placeholder", new_string: newlyWrittenEmbedded.join("\n") });
      const scopedMsg2 = scopedHit2?.hookSpecificOutput?.additionalContext ?? "";
      check("hook (Edit touching ONE embedded anchor): fires", scopedHit2 !== null);
      check("hook (Edit touching ONE embedded anchor): the embedded-anchor count is exactly 1, not 2",
        /^1 embedded @decision anchor\(s\)/m.test(scopedMsg2));
      check("hook (Edit touching ONE embedded anchor): names ONLY the newly-written id, not the pre-existing one",
        /deadc0d1 embedded/.test(scopedMsg2) && !/aaaaaaa1 embedded/.test(scopedMsg2));
      check("hook (Edit touching ONE embedded anchor): no split-anchor-paragraph section at all (that edit never touched one)",
        !/split @decision anchor paragraph/.test(scopedMsg2));

      // An Edit touching NONE of the embedded/split sites — neither field's section appears at all.
      const noneHit2 = runHookProc2(scopePath2, "Edit", { old_string: "placeholder", new_string: "// a completely unrelated one-line comment, touches nothing" });
      const noneMsg2 = noneHit2?.hookSpecificOutput?.additionalContext ?? "";
      check("hook (Edit touching none of the embedded/split sites): no embedded-anchor section at all",
        !/embedded @decision anchor/.test(noneMsg2));
      check("hook (Edit touching none of the embedded/split sites): no split-anchor-paragraph section at all",
        !/split @decision anchor paragraph/.test(noneMsg2));
    } finally {
      try { fs.rmSync(scopeDir2, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // --- writeSessionSettings wiring: gated on the explicit `docLint` param (card d92ec82b), independently
  // of vaultPath (which stays vault-lint's own gate) -----------------------------------------------------
  ensureDirs();
  const perm = { mode: "acceptEdits", allow: [], deny: [] };
  const findGroup = (settings, needle) =>
    (settings.hooks.PostToolUse || []).find((g) => g.matcher === "Write|Edit" && g.hooks[0].command.includes(needle));

  // ON-case FIRST (same DoD-4 ordering): docLint:true + vaultPath given + repoPath given → wired. (The
  // realistic combination sessions/service.ts produces: vaultPath is only ever set when docLint is true.)
  const on = JSON.parse(fs.readFileSync(writeSessionSettings("cal-on", perm, "test-hook-token", "/some/vault", REPO, true), "utf8"));
  const onGroup = findGroup(on, "comment-anchor-lint.mjs");
  check("writeSessionSettings(vaultPath+repoPath): comment-anchor-lint Write|Edit group present", !!onGroup);
  check("writeSessionSettings(vaultPath+repoPath): command uses --hook mode with the repo root",
    !!onGroup && onGroup.hooks[0].command.includes("--hook") && onGroup.hooks[0].command.includes(REPO));
  check("writeSessionSettings(vaultPath+repoPath): vault-lint's own group is STILL present (additive, not replaced)",
    !!findGroup(on, "vault-lint.mjs"));

  // docLint on but repoPath omitted → comment-anchor-lint absent (no repo root to scope it to).
  const onNoRepo = JSON.parse(fs.readFileSync(writeSessionSettings("cal-on-norepo", perm, "test-hook-token", "/some/vault"), "utf8"));
  check("writeSessionSettings(vaultPath, no repoPath): comment-anchor-lint group ABSENT", !findGroup(onNoRepo, "comment-anchor-lint.mjs"));
  check("writeSessionSettings(vaultPath, no repoPath): vault-lint's own group unaffected", !!findGroup(onNoRepo, "vault-lint.mjs"));

  // --- card d92ec82b: docLint:true + repoPath + NO vaultPath (no Obsidian vault configured) ------------
  // THE GAP THIS CARD FIXES: comment-anchor-lint targets SOURCE files, not vault notes, so it should wire
  // regardless of whether a vault is configured. Before d92ec82b this hook was gated on `vaultPath`
  // truthiness alone (a proxy for "docLint is on" that could not distinguish it from "a vault is
  // configured") — this is the exact positive control that pre-change code FAILS: with no 6th `docLint`
  // arg even accepted, the old code reads `vaultPath` (undefined here) and never wires the hook. Run this
  // block against pre-fix code (git-stash the source changes, rebuild, rerun) to see it fail RED; against
  // the fix, it must pass GREEN.
  const onNoVault = JSON.parse(fs.readFileSync(writeSessionSettings("cal-on-novault", perm, "test-hook-token", undefined, REPO, true), "utf8"));
  check("writeSessionSettings(docLint:true, repoPath, NO vaultPath): comment-anchor-lint group PRESENT (the fix)",
    !!findGroup(onNoVault, "comment-anchor-lint.mjs"));
  check("writeSessionSettings(docLint:true, repoPath, NO vaultPath): vault-lint's own group ABSENT (no vault to lint)",
    !findGroup(onNoVault, "vault-lint.mjs"));

  // docLint:false + repoPath given, vaultPath omitted → comment-anchor-lint absent even though repoPath is
  // present (docLint itself must gate it, not just repoPath's presence).
  const offNoVault = JSON.parse(fs.readFileSync(writeSessionSettings("cal-off-novault", perm, "test-hook-token", undefined, REPO, false), "utf8"));
  check("writeSessionSettings(docLint:false, repoPath, no vaultPath): comment-anchor-lint group ABSENT",
    !findGroup(offNoVault, "comment-anchor-lint.mjs"));

  // OFF-case (docLint off — no vaultPath), repoPath STILL given → must be byte-identical to today: absent.
  const off = JSON.parse(fs.readFileSync(writeSessionSettings("cal-off", perm, "test-hook-token", undefined, REPO), "utf8"));
  check("writeSessionSettings(no vaultPath / docLint off, repoPath given): comment-anchor-lint group ABSENT",
    !findGroup(off, "comment-anchor-lint.mjs"));
  check("writeSessionSettings(no vaultPath / docLint off): vault-lint's own group ALSO absent (unchanged behavior)",
    !findGroup(off, "vault-lint.mjs"));
  check("writeSessionSettings(no vaultPath / docLint off): decision-records Read hook still present (unaffected)",
    (off.hooks.PostToolUse || []).some((g) => g.matcher === "Read" && g.hooks[0].command.includes("decision-records.mjs")));
} finally {
  try { fs.rmSync(REPO, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const s of ["cal-on", "cal-on-norepo", "cal-on-novault", "cal-off-novault", "cal-off"]) {
    try { fs.rmSync(path.join(SETTINGS_DIR, `${s}.json`), { force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — comment-anchor-lint's per-file hook mode fires (with a genuine positive control) on an "
    + "in-scope violating file, stays silent on a clean file / wrong tool / out-of-scope file, and "
    + "writeSessionSettings wires it only when the explicit docLint param is true AND repoPath is given — "
    + "independently of vaultPath (card d92ec82b), including the docLint:true+repoPath+NO-vaultPath case "
    + "the old vaultPath-proxy gate missed — while docLint off stays byte-identical to today."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
