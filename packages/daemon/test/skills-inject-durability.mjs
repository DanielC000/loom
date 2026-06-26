// Regression guard for two silent-failure swallows in skills/inject.ts (PL gap-hunt cleanup):
//   (1) the per-skill copy used a bare `fs.cpSync(...)` with an EMPTY catch — a copy that failed silently
//       skipped the skill, so a session could run WITHOUT its pinned doctrine skill. Now the copy is atomic
//       (tmp+swap), RETRIED, and a persistent failure is SURFACED (injectSkills throws; the spawn caller
//       logs it non-fatally) instead of swallowed.
//   (2) the manifest write was a bare (non-atomic) writeFileSync — a torn write corrupts the shared
//       per-session record. Now it's tmp+rename. And readManifest swallowed a PARSE error the same as a
//       missing file; a present-but-corrupt manifest is now logged (surfaced) and recovered to an empty map.
// Hermetic — sets LOOM_HOME to a temp dir BEFORE importing (paths.ts reads it at load). No claude.
// Run after build: node test/skills-inject-durability.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-inject-durability-${Date.now()}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
fs.mkdirSync(skillsDir, { recursive: true });
const mkSkill = (n) => { fs.mkdirSync(path.join(skillsDir, n), { recursive: true }); fs.writeFileSync(path.join(skillsDir, n, "SKILL.md"), `---\nname: ${n}\ndescription: ${n}\n---\n${n}`); };
mkSkill("loom-a");
mkSkill("loom-b");

process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR at load
const { injectSkills } = await import("../dist/skills/inject.js");

// Capture daemon-log surfacing so we can assert failures are no longer silent.
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(" ")); };
const sawLog = (re) => logs.some((l) => re.test(l));

try {
  // ============ (1) A copy that FAILS is surfaced (throws) + recovered, not silently skipped ============
  // Force a deterministic, cross-platform copy failure for ONE skill by pre-occupying its tmp path with a
  // FILE: copySkillAtomic copies the store DIR into `<dest>.loom-tmp`, and cpSync(dir -> existing file)
  // throws ERR_FS_CP_DIR_TO_NON_DIR every attempt. The OTHER skill must still land (recovery).
  const cwd1 = path.join(root, "repo1");
  const tdir1 = path.join(cwd1, ".claude", "skills");
  fs.mkdirSync(tdir1, { recursive: true });
  fs.writeFileSync(path.join(tdir1, "loom-a.loom-tmp"), "occupied"); // jam loom-a's tmp swap path

  let threw = false;
  try { injectSkills(cwd1, "sess-fail", null); } catch { threw = true; }
  check("a persistent copy failure is SURFACED (injectSkills throws, not a silent skip)", threw);
  check("the failing skill name is reported in the daemon log", sawLog(/failed to inject 'loom-a'/));
  check("the OTHER skill still landed (partial success recovered)", fs.existsSync(path.join(tdir1, "loom-b", "SKILL.md")));
  check("the failed skill is NOT recorded in the manifest", (() => {
    const m = JSON.parse(fs.readFileSync(path.join(tdir1, ".loom-skills.json"), "utf8"));
    return Array.isArray(m["sess-fail"]) && m["sess-fail"].includes("loom-b") && !m["sess-fail"].includes("loom-a");
  })());

  // Once the jam is cleared, a re-inject delivers the previously-failed skill (no permanent dead-end).
  fs.rmSync(path.join(tdir1, "loom-a.loom-tmp"), { force: true });
  let threw2 = false;
  try { injectSkills(cwd1, "sess-fail", null); } catch { threw2 = true; }
  check("re-inject after the jam clears succeeds (no throw)", !threw2);
  check("the previously-failed skill now lands", fs.existsSync(path.join(tdir1, "loom-a", "SKILL.md")));

  // ============ (1b) atomicity: a failed copy leaves the EXISTING live skill intact ============
  // Pre-place loom-a as MINE, then jam its tmp and re-inject → the copy fails but the live loom-a must NOT
  // be nuked (the old code rm'd dest BEFORE copying, so a failed copy left the session with no skill).
  const cwd2 = path.join(root, "repo2");
  const tdir2 = path.join(cwd2, ".claude", "skills");
  fs.mkdirSync(tdir2, { recursive: true });
  injectSkills(cwd2, "sess-keep", null); // loom-a + loom-b land normally
  check("setup: loom-a present before the jam", fs.existsSync(path.join(tdir2, "loom-a", "SKILL.md")));
  fs.writeFileSync(path.join(tdir2, "loom-a.loom-tmp"), "occupied"); // jam the swap for the NEXT inject
  try { injectSkills(cwd2, "sess-keep", null); } catch { /* expected throw */ }
  check("a failed re-copy leaves the EXISTING live skill intact (not nuked)", fs.existsSync(path.join(tdir2, "loom-a", "SKILL.md")));
  fs.rmSync(path.join(tdir2, "loom-a.loom-tmp"), { force: true });

  // ============ (2) torn / corrupt manifest is surfaced + recovered, not silently swallowed ============
  const cwd3 = path.join(root, "repo3");
  const tdir3 = path.join(cwd3, ".claude", "skills");
  fs.mkdirSync(tdir3, { recursive: true });
  fs.writeFileSync(path.join(tdir3, ".loom-skills.json"), "{ this is not valid json"); // a torn write
  logs.length = 0;
  let threw3 = false;
  try { injectSkills(cwd3, "sess-torn", null); } catch { threw3 = true; }
  check("a corrupt manifest does NOT crash injection (recovers)", !threw3);
  check("the corrupt manifest is SURFACED in the daemon log (not silently swallowed)", sawLog(/corrupt manifest/));
  check("injection still delivers the skills despite the torn manifest", fs.existsSync(path.join(tdir3, "loom-a", "SKILL.md")) && fs.existsSync(path.join(tdir3, "loom-b", "SKILL.md")));
  check("the manifest is rewritten to valid JSON (atomic write recovered it)", (() => {
    try { const m = JSON.parse(fs.readFileSync(path.join(tdir3, ".loom-skills.json"), "utf8")); return Array.isArray(m["sess-torn"]); }
    catch { return false; }
  })());
  check("no leftover manifest .tmp after the atomic write", !fs.existsSync(path.join(tdir3, ".loom-skills.json.tmp")));

  // ============ (2b) a MISSING manifest stays silent (normal first run, not surfaced as corrupt) ============
  const cwd4 = path.join(root, "repo4");
  fs.mkdirSync(cwd4, { recursive: true });
  logs.length = 0;
  injectSkills(cwd4, "sess-fresh", null);
  check("a missing manifest (first run) is NOT logged as corrupt", !sawLog(/corrupt manifest/));
} finally {
  console.log = origLog;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — inject copy failures are atomic+retried+surfaced (not swallowed); the manifest write is atomic; a corrupt manifest is surfaced + recovered."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
