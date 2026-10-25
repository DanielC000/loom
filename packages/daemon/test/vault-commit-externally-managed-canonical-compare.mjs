import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure real-git exercise.
// Card 70ce37f5 (found by 35dff468's worker): commitVault's own "externally managed" check
// (vault/versioner.ts) decided whether vaultPath IS the discovered repo root via a RAW STRING compare —
// `root.replace(/\\/g,"/") !== vaultPath.replace(/\\/g,"/")` — against git's own `rev-parse
// --show-toplevel` output. git's own output is always ITS canonical spelling (real on-disk case, no
// `\\?\` prefix, resolved through a junction), so ANY vaultPath spelling that discovery normalizes away
// made the raw compare mismatch even though vaultPath canonically WAS the confirmed root — misclassified
// as "externally managed" and silently never committed, no reason surfaced.
//
// Fixed by canonicalizing BOTH sides (via `canonicalizeForContainment` — the SAME canonicalization
// validateVaultPath/checkVaultRepoTripleContainment already trust) and comparing with `comparisonKey`.
// See docs/decisions/70ce37f5-commitvault-canonicalize-before-externally-managed-compare.md.
//
// This proves:
//  [1] the `\\?\<drive>:\...` extended-length form now commits (the card's originally-reported shape);
//  [2] a case-variant spelling of the SAME real directory now commits (found while investigating — the
//      same raw-compare defect, not limited to the device-form prefix);
//  [3] a junction spelling of the SAME real directory now commits (same mechanism as [2]);
//  [4] NEGATIVE CONTROL — an ordinary-spelled vaultPath commits, unaffected;
//  [5] a GENUINE subfolder of a bigger repo still correctly backs off (externally managed) — the fix must
//      not lose the real detection this check exists for;
//  [6] a trailing-dot/space vaultPath is refused with its OWN named log line (canonicalizeForContainment's
//      `hasWin32UnsafeTrailingSegment` refusal) — never silently falls back to the old raw compare.
//
// Run after build: node test/vault-commit-externally-managed-canonical-compare.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

if (process.platform !== "win32") {
  console.log("SKIP  entire suite (win32-only: exercises \\\\?\\ extended-length paths, junctions, and Windows trailing-dot/case semantics)");
  await finishAndExit(0);
}

const { commitVault } = await import("../dist/vault/versioner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "-c", "user.email=vault-cmp-test@example.com", "-c", "user.name=vault-cmp-test", "commit", "--allow-empty", "-q", "-m", "init");
}

const root = fs.realpathSync(mkdtempManaged("loom-vault-ext-managed-cmp-"));

// ═══ [1]+[2]+[3]+[4] one physical repo, four spellings — only the spelling varies ═══
{
  const repo = path.join(root, "repoA");
  initRepo(repo);

  async function commitsAtrial(label, vaultPathForCall) {
    fs.writeFileSync(path.join(repo, `note-${label}.md`), `hello from ${label}\n`);
    const result = await commitVault(vaultPathForCall, `probe commit (${label})`);
    return result.committed === true;
  }

  check("[4] NEGATIVE CONTROL: an ordinary-spelled vaultPath commits", await commitsAtrial("ordinary", repo));
  check(
    "[1] the \\\\?\\<drive>:\\... extended-length form commits (card 70ce37f5)",
    await commitsAtrial("extended-length", "\\\\?\\" + repo),
  );
  check(
    "[2] a case-variant spelling of the SAME real directory commits (card 70ce37f5)",
    await commitsAtrial("different-case", repo.toLowerCase()),
  );
  const junction = path.join(root, "repoA-junction");
  fs.symlinkSync(repo, junction, "junction");
  try {
    check(
      "[3] a junction spelling of the SAME real directory commits (card 70ce37f5)",
      await commitsAtrial("junction", junction),
    );
  } finally {
    fs.rmSync(junction, { force: true });
  }
}

// ═══ [5] a GENUINE subfolder of a bigger repo must still correctly back off ═══
{
  const repo = path.join(root, "repoB");
  initRepo(repo);
  const subdir = path.join(repo, "notes");
  fs.mkdirSync(subdir);
  fs.writeFileSync(path.join(subdir, "x.md"), "hi\n");
  const result = await commitVault(subdir, "probe genuine-subfolder commit");
  check("[5] a genuine subfolder of a bigger repo still backs off (externally managed, unaffected by this fix)", result.committed === false);
}

// ═══ [6] a trailing-dot/space vaultPath is refused with ITS OWN named log, never the old raw compare ═══
{
  const repo = path.join(root, "repoC");
  initRepo(repo);
  const trailingDot = repo + ".";
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  let result;
  try {
    result = await commitVault(trailingDot, "probe trailing-dot commit");
  } finally {
    console.warn = origWarn;
  }
  check("[6] a trailing-dot vaultPath is refused (committed:false)", result.committed === false);
  check(
    "[6] the refusal names the canonicalization failure (never a silent raw-compare fallback)",
    warnings.some((w) => w.includes("could not canonicalize vaultPath") && w.includes("segment ending in")),
  );
}

console.log(failures === 0
  ? "\nALL PASS — commitVault's externally-managed check compares CANONICAL paths, closing the device-form/case/junction false-negative while preserving the genuine-subfolder backoff."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
