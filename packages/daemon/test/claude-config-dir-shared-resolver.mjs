import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card a92a0913 — honour CLAUDE_CONFIG_DIR when locating engine transcripts, and in the transcript-root
// deny. HERMETIC: no daemon, no real claude, no real homedir touched (HOME/USERPROFILE sandboxed to a
// throwaway temp dir in EVERY scenario below, including the ones that also set CLAUDE_CONFIG_DIR).
//
// Proves the shared resolver (claudeConfigHome, claude-config.ts) and its two consumers
// (engineTranscriptPath/resolveTranscriptFile/listAllTranscriptIds in claude-transcript.ts, and the
// transcript-root deny rules it also feeds) all follow CLAUDE_CONFIG_DIR when it's set, fall back to a
// byte-identical shape to before this card when it's unset, and that an EMPTY CLAUDE_CONFIG_DIR falls
// back too (the one case this card's own decision record proves matches the CLI's own behaviour — see
// docs/decisions/a92a0913-claude-config-dir-shared-resolver.md's "Named residual" for the relative case,
// deliberately NOT covered here).
//
// Every check below is written so a mutant that KEEPS the fixed API but silently reverts its LOGIC to
// the pre-fix shape (raw os.homedir(), ignoring CLAUDE_CONFIG_DIR) would fail it — never a check whose
// only failure mode is "the export doesn't exist" (lesson 298). Concretely: every CLAUDE_CONFIG_DIR-set
// assertion below computes the OLD (pre-fix) expected value too and asserts the REAL result differs from
// it, not merely that it equals the new expected value.
//
// Run: 1) build (turbo builds shared first), 2) node test/claude-config-dir-shared-resolver.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("loom-ccdsr-"); // sets LOOM_HOME before any dist import — paths.js reads it at module load

const { claudeConfigHome, claudeJsonPath } = await import("../dist/pty/claude-config.js");
const {
  engineTranscriptPath, resolveTranscriptFile, listAllTranscriptIds, encodeProjectDir,
  transcriptRootReadDenyRules, otherProjectTranscriptDenyRules, TRANSCRIPT_ROOT_READ_DENY_RULE,
} = await import("../dist/pty/claude-transcript.js");
const { toClaudeAbsoluteGlob } = await import("../dist/pty/loom-home-deny.js");

const ROLE_DENY = TRANSCRIPT_ROOT_READ_DENY_RULE;
const fakeCwd = (tag) => path.resolve(`/fake/ccdsr-${tag}`);
const sessionId = (i) => `${Date.now()}-${process.pid}-${String(i).padStart(4, "0")}-aaaaaaaaaaaaaaaaaaaaaaaaaaaa`; // uuid-shaped-ish, globally unique

// =====================================================================================================
// SCENARIO A — CLAUDE_CONFIG_DIR SET: everything follows it, NOT os.homedir()/sandboxHome.
// =====================================================================================================
{
  const sandboxHome = mkdtempManaged("loom-ccdsr-home-a-");
  const configDir = mkdtempManaged("loom-ccdsr-config-a-");
  process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
  process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
  process.env.CLAUDE_CONFIG_DIR = configDir;

  check("A: claudeConfigHome() resolves to CLAUDE_CONFIG_DIR, NOT the sandboxed homedir",
    path.resolve(claudeConfigHome()) === path.resolve(configDir)
    && path.resolve(claudeConfigHome()) !== path.resolve(sandboxHome));

  check("A: claudeJsonPath() is under CLAUDE_CONFIG_DIR, NOT <homedir>/.claude.json (the pre-fix path)",
    path.resolve(claudeJsonPath()) === path.resolve(path.join(configDir, ".claude.json"))
    && path.resolve(claudeJsonPath()) !== path.resolve(path.join(sandboxHome, ".claude.json")));

  const cwd = fakeCwd("a1");
  const id = sessionId(1);
  const computed = engineTranscriptPath(cwd, id);
  const preFixWould = path.join(sandboxHome, ".claude", "projects", encodeProjectDir(cwd), `${id}.jsonl`);
  check("A: engineTranscriptPath() is under CLAUDE_CONFIG_DIR/projects/..., NOT the pre-fix os.homedir()-based path",
    path.resolve(computed) === path.resolve(path.join(configDir, "projects", encodeProjectDir(cwd), `${id}.jsonl`))
    && path.resolve(computed) !== path.resolve(preFixWould));

  // resolveTranscriptFile's fallback scan: write the REAL fixture under CLAUDE_CONFIG_DIR/projects/..., and
  // a DECOY under the pre-fix sandboxHome/.claude/projects/... with a DIFFERENT id — proves the scan reads
  // the NEW root exclusively (a mutant that dual-scanned both, or reverted to the old root alone, fails this).
  fs.mkdirSync(path.dirname(computed), { recursive: true });
  fs.writeFileSync(computed, '{"type":"user","message":{"content":"hi"}}\n');
  const decoyId = sessionId(2);
  const decoyDir = path.join(sandboxHome, ".claude", "projects", "decoy-dir");
  fs.mkdirSync(decoyDir, { recursive: true });
  fs.writeFileSync(path.join(decoyDir, `${decoyId}.jsonl`), '{"type":"user","message":{"content":"decoy"}}\n');

  // A cwd whose OWN computed path misses (so resolveTranscriptFile must fall through to the readdir scan).
  const missCwd = fakeCwd("a-miss");
  check("A: resolveTranscriptFile finds the real fixture via the fallback scan under CLAUDE_CONFIG_DIR/projects",
    path.resolve(resolveTranscriptFile(missCwd, id) ?? "") === path.resolve(computed));
  check("A: resolveTranscriptFile does NOT find the decoy planted under the pre-fix sandboxHome/.claude/projects root",
    resolveTranscriptFile(missCwd, decoyId) === null);

  const ids = listAllTranscriptIds();
  check("A: listAllTranscriptIds()'s default root follows CLAUDE_CONFIG_DIR (sees the real fixture id)", ids.has(id));
  check("A: listAllTranscriptIds()'s default root does NOT see the decoy under the pre-fix root (proves it isn't scanning sandboxHome)", !ids.has(decoyId));

  // The transcript-root deny: BOTH the kept home-relative rule AND the new absolute-path sibling, built
  // from the SAME CLAUDE_CONFIG_DIR-aware root (never the pre-fix sandboxHome-based literal). Round 3
  // (card a92a0913): on win32 ONLY, a THIRD plain forward-slashed sibling is also expected — never
  // hand-asserted as a literal here, always derived the same way the production resolver computes it,
  // so this test can't drift from it independently.
  const projectsRoot = path.join(configDir, "projects");
  const expectedAbsolute = `Read(${toClaudeAbsoluteGlob(projectsRoot)}/**)`;
  const expectedPlainSlashed = `Read(${projectsRoot.replace(/\\/g, "/")}/**)`;
  const expectedTranscriptRootRules = process.platform === "win32"
    ? [ROLE_DENY, expectedAbsolute, expectedPlainSlashed]
    : [ROLE_DENY, expectedAbsolute];
  const rules = transcriptRootReadDenyRules();
  check("A: transcriptRootReadDenyRules() keeps the home-relative rule exactly, unconditionally", rules.includes(ROLE_DENY));
  check("A: transcriptRootReadDenyRules() ALSO adds the absolute-path sibling(s), built from CLAUDE_CONFIG_DIR (a third plain-slashed sibling on win32)",
    JSON.stringify(rules) === JSON.stringify(expectedTranscriptRootRules));

  const otherRules = otherProjectTranscriptDenyRules("ccdsr-other", "/repos/ccdsr-other");
  check("A: otherProjectTranscriptDenyRules() keeps both home-relative shapes exactly, unconditionally",
    otherRules[0] === "Read(~/.claude/projects/*-ccdsr-other-*/**)"
    && otherRules[1] === `Read(~/.claude/projects/${encodeProjectDir("/repos/ccdsr-other")}/**)`);
  const expectedOtherAbsolute = [
    `Read(${toClaudeAbsoluteGlob(projectsRoot)}/*-ccdsr-other-*/**)`,
    `Read(${toClaudeAbsoluteGlob(projectsRoot)}/${encodeProjectDir("/repos/ccdsr-other")}/**)`,
  ];
  const expectedOtherPlainSlashed = [
    `Read(${projectsRoot.replace(/\\/g, "/")}/*-ccdsr-other-*/**)`,
    `Read(${projectsRoot.replace(/\\/g, "/")}/${encodeProjectDir("/repos/ccdsr-other")}/**)`,
  ];
  const expectedOtherRules = process.platform === "win32"
    ? ["Read(~/.claude/projects/*-ccdsr-other-*/**)", `Read(~/.claude/projects/${encodeProjectDir("/repos/ccdsr-other")}/**)`, ...expectedOtherAbsolute, ...expectedOtherPlainSlashed]
    : ["Read(~/.claude/projects/*-ccdsr-other-*/**)", `Read(~/.claude/projects/${encodeProjectDir("/repos/ccdsr-other")}/**)`, ...expectedOtherAbsolute];
  check("A: otherProjectTranscriptDenyRules() ALSO adds the absolute-path siblings, built from CLAUDE_CONFIG_DIR (two more plain-slashed siblings on win32)",
    JSON.stringify(otherRules) === JSON.stringify(expectedOtherRules));
}

// =====================================================================================================
// SCENARIO B — CLAUDE_CONFIG_DIR UNSET (sandboxed HOME only): byte-identical shape to before this card.
// =====================================================================================================
{
  delete process.env.CLAUDE_CONFIG_DIR;
  const sandboxHome = mkdtempManaged("loom-ccdsr-home-b-");
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;

  check("B: claudeConfigHome() falls back to the sandboxed homedir when CLAUDE_CONFIG_DIR is unset",
    path.resolve(claudeConfigHome()) === path.resolve(sandboxHome));
  check("B: claudeJsonPath() falls back to <homedir>/.claude.json",
    path.resolve(claudeJsonPath()) === path.resolve(path.join(sandboxHome, ".claude.json")));

  const cwd = fakeCwd("b1");
  const id = sessionId(3);
  check("B: engineTranscriptPath() falls back to <homedir>/.claude/projects/...",
    path.resolve(engineTranscriptPath(cwd, id)) === path.resolve(path.join(sandboxHome, ".claude", "projects", encodeProjectDir(cwd), `${id}.jsonl`)));

  const rules = transcriptRootReadDenyRules();
  check("B: transcriptRootReadDenyRules() returns EXACTLY the one home-relative rule (byte-identical to before this card) — a mutant that always added the second entry fails this",
    JSON.stringify(rules) === JSON.stringify([ROLE_DENY]));

  const otherRules = otherProjectTranscriptDenyRules("ccdsr-other-b", "/repos/ccdsr-other-b");
  check("B: otherProjectTranscriptDenyRules() returns EXACTLY the two documented home-relative shapes (byte-identical) — a mutant that always added the two siblings fails this",
    otherRules.length === 2
    && otherRules[0] === "Read(~/.claude/projects/*-ccdsr-other-b-*/**)"
    && otherRules[1] === `Read(~/.claude/projects/${encodeProjectDir("/repos/ccdsr-other-b")}/**)`);
}

// =====================================================================================================
// SCENARIO C — CLAUDE_CONFIG_DIR set to the EMPTY STRING: falls back to homedir, same as unset (the ONE
// CLI edge-case this card's shared resolver is proven to match — see the decision record's residual note
// for the UNcovered relative-path case).
// =====================================================================================================
{
  const sandboxHome = mkdtempManaged("loom-ccdsr-home-c-");
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
  process.env.CLAUDE_CONFIG_DIR = "";

  check("C: an EMPTY CLAUDE_CONFIG_DIR falls back to the sandboxed homedir (matches the CLI's own empty-string behaviour)",
    path.resolve(claudeConfigHome()) === path.resolve(sandboxHome));
  const rules = transcriptRootReadDenyRules();
  check("C: an EMPTY CLAUDE_CONFIG_DIR does NOT trigger the absolute-path sibling (treated as unset)",
    JSON.stringify(rules) === JSON.stringify([ROLE_DENY]));
}

delete process.env.CLAUDE_CONFIG_DIR;

console.log(failures === 0
  ? "\n✅ ALL PASS — claudeConfigHome() is the one shared resolver behind claudeJsonPath and every " +
    "claude-transcript.ts consumer (engineTranscriptPath/resolveTranscriptFile/listAllTranscriptIds/the " +
    "transcript-root deny rules); CLAUDE_CONFIG_DIR is honoured when set, an empty value falls back like " +
    "unset, and the unset shape is byte-identical to before this card."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
