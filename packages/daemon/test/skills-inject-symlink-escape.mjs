// Regression guard for card 5c3d0518 (from the review of 97e6a1c6): if `.claude` or `.claude/skills`
// resolves OUTSIDE the session's own cwd — a Windows junction, or (mainly on POSIX, where a committed
// git symlink materializes — Windows core.symlinks=false checkouts don't create one) a real symlink —
// every injection write (mkdir, the skill copies, the manifest) used to land wherever that link points,
// not under the repo. `fs.mkdirSync(targetDir, { recursive: true })` happily follows an EXISTING
// symlink/junction ancestor, so the fix must check BEFORE any write, not after.
// Hermetic — sets LOOM_HOME to a temp dir BEFORE importing (paths.ts reads it at load). No claude.
// Run after build: node test/skills-inject-symlink-escape.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-inject-symlink-escape-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
fs.mkdirSync(skillsDir, { recursive: true });
const mkSkill = (n) => {
  fs.mkdirSync(path.join(skillsDir, n), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, n, "SKILL.md"), `---\nname: ${n}\ndescription: ${n}\n---\n${n}`);
};
mkSkill("loom-a");

process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR at load
const { injectSkills } = await import("../dist/skills/inject.js");

// Capture daemon-log surfacing so we can assert the refusal is actually logged, not merely silent.
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(" ")); };
const sawLog = (re) => logs.some((l) => re.test(l));

try {
  // ============ (A) `.claude` ITSELF is a junction/symlink pointing outside the repo ============
  // 'junction' needs no elevation on Windows; a plain 'dir' symlink needs none on POSIX either — so this
  // case always runs (no skip needed), matching the DoD's "Windows: mklink /J" example.
  logs.length = 0;
  const repoA = path.join(root, "repoA");
  fs.mkdirSync(repoA, { recursive: true });
  const elsewhereA = path.join(root, "elsewhere-A"); // sibling of repoA, outside it
  fs.mkdirSync(elsewhereA, { recursive: true });
  fs.symlinkSync(elsewhereA, path.join(repoA, ".claude"), process.platform === "win32" ? "junction" : "dir");

  injectSkills(repoA, "sess-a", null, "worker");
  check("(A) junctioned/symlinked .claude: nothing landed at the real target (no skills/ subdir)", !fs.existsSync(path.join(elsewhereA, "skills")));
  check("(A) junctioned/symlinked .claude: the target dir is otherwise untouched", fs.readdirSync(elsewhereA).length === 0);
  check("(A) the refusal is logged loudly", sawLog(/\[skills\] refusing injection/) && sawLog(/\.claude/));

  // ============ (B) `.claude` is REAL, but `.claude/skills` itself is a symlink pointing outside ============
  // This is the "committed git symlink" shape the card calls out — skip cleanly (not a FAIL) if this host
  // can't create a plain symlink without elevation (stock Windows, no Developer Mode / admin).
  logs.length = 0;
  const repoB = path.join(root, "repoB");
  fs.mkdirSync(path.join(repoB, ".claude"), { recursive: true });
  const elsewhereB = path.join(root, "elsewhere-B");
  fs.mkdirSync(elsewhereB, { recursive: true });
  let linkOk = false;
  try { fs.symlinkSync(elsewhereB, path.join(repoB, ".claude", "skills"), "dir"); linkOk = true; }
  catch { /* no symlink privilege on this host — case skipped below, not failed */ }

  if (linkOk) {
    injectSkills(repoB, "sess-b", null, "worker");
    check("(B) symlinked .claude/skills: nothing landed at the real target", fs.readdirSync(elsewhereB).length === 0);
    check("(B) the refusal is logged loudly", sawLog(/\[skills\] refusing injection/) && sawLog(/skills/));
  } else {
    console.log = origLog;
    console.log("SKIP  (B) symlink case — could not create a symlink on this host (no privilege)");
    console.log = (...a) => { logs.push(a.join(" ")); };
  }

  // ============ (C) CONTROL: an ordinary cwd with no link anywhere still gets skills injected ============
  // Proves the guard isn't just refusing everything — it only fires for a genuine escape.
  logs.length = 0;
  const repoC = path.join(root, "repoC");
  fs.mkdirSync(repoC, { recursive: true });
  injectSkills(repoC, "sess-c", null, "worker");
  check("(C) CONTROL: a normal repo with no symlink still gets its skill delivered", fs.existsSync(path.join(repoC, ".claude", "skills", "loom-a", "SKILL.md")));
  check("(C) CONTROL: no refusal is logged for the normal case", !sawLog(/\[skills\] refusing injection/));
} finally {
  console.log = origLog;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — skill injection refuses a .claude/.claude-skills ancestor that resolves outside the working directory."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
