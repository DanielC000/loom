import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure real-git exercise.
// Card 306dd105 — round-2 Code Review of `ffe98495` (MINOR-1, verified on Windows with git 2.47):
// `commitVault`'s discovery step (vault/versioner.ts) blanket-caught every `checkIsRepo()` error and
// defaulted to `isRepo = false`. A vault made to LOOK like a bare repo (plain `HEAD`/`objects/`/`refs/`
// files at its own root — exactly what `vault_write` could produce) makes git's OWN
// `safe.bareRepository=explicit` refusal fire as a REAL fatal error ("cannot use bare repository ...",
// NOT "not a git repository"). The old blanket `.catch(() => false)` mapped that refusal to "no repo
// here", so `commitVault` then `git init`'d a NESTED repo — even when the vault sits inside a real,
// externally-managed parent repo it must never touch.
//
// This proves:
//  [1] the literal repro — discovery now fails CLOSED (skips the commit, logs why) instead of
//      initialising a nested .git;
//  [2] negative control — an ORDINARY not-a-repo vault (no planted bare-repo-looking files) still
//      correctly git-inits and commits, so the fail-closed fix is not a blanket refusal;
//  [3] the independent outside-vault probe (DoD-2) — even when discovery itself cleanly resolves
//      "not a repo" (forced via an injected gitFactory, bypassing the bare-repo-illusion path entirely),
//      a REAL enclosing repo one level up still gets detected and refuses the init.
//  [4] ROUND 2 — the LC_ALL=C/LANGUAGE=C locale pin on both message-classified probes (discovery
//      checkIsRepo, the outside-vault revparse): without it, a non-English host locale defeats
//      isNotAGitRepositoryError's English-only pattern and a brand-new standalone vault would fail
//      closed FOREVER instead of ever git-init'ing. An injected gitFactory captures the env each probe
//      actually receives and simulates a LOCALIZED rejection when that env isn't pinned.
//
// Run after build: node test/vault-commit-fail-closed-discovery.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { simpleGit } from "simple-git";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const { commitVault } = await import("../dist/vault/versioner.js");
const { isNotAGitRepositoryError } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "vault-fail-closed@example.com");
  git(dir, "config", "user.name", "vault-fail-closed-test");
}
// `git rev-list --all --count` is 0 (clean exit) on a fresh repo with no commits — unlike `git log`.
const commitCount = (dir) => parseInt(git(dir, "rev-list", "--all", "--count").trim() || "0", 10);

// Plants the exact three files the card's own repro names (HEAD / objects/a.md / refs/a.md) — making `dir`
// LOOK like a bare repo root to git's own discovery under `safe.bareRepository=explicit`.
function plantFakeBareRepoIllusion(dir) {
  fs.mkdirSync(path.join(dir, "objects"), { recursive: true });
  fs.mkdirSync(path.join(dir, "refs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, "objects", "a.md"), "fake\n");
  fs.writeFileSync(path.join(dir, "refs", "a.md"), "fake\n");
}

const root = fs.realpathSync(mkdtempManaged("loom-vault-fail-closed-"));
// Round 2 item 4 (optional, cheap): bound every real git child's upward discovery to `root` so test [2]'s
// "ordinary not-a-repo vault" negative control can't false-fail on a host whose tmpdir happens to sit
// inside a real repo. commitVault's discovery calls inherit process.env when no env override is given
// (see boundedVaultGit), so setting this here reaches every real git spawn below.
process.env.GIT_CEILING_DIRECTORIES = root;

// ═══ [1] THE LITERAL REPRO: a vault made to look like a bare repo, nested in a real externally-managed parent ═══
{
  const parentRepo = path.join(root, "parent1");
  initRepo(parentRepo);
  git(parentRepo, "commit", "--allow-empty", "-q", "-m", "init");
  const vault = path.join(parentRepo, "vault");
  fs.mkdirSync(vault, { recursive: true });
  plantFakeBareRepoIllusion(vault);

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  let result;
  try {
    result = await commitVault(vault, "loom: should be skipped (fail-closed)");
  } finally {
    console.warn = origWarn;
  }

  // (control, round 2 item 2) — "SKIPS/returns false" and "parent history untouched" would ALSO pass if
  // discovery failed closed for some unrelated reason; they're sanity checks, not proof the bare-repo-
  // illusion discovery path specifically fired. The warning-text check below is the actual proof.
  check("[1] (control) commitVault SKIPS (committed:false) rather than initialising on a bare-repo-illusion vault", result.committed === false);
  check("[1] NO nested .git was created inside the vault", !fs.existsSync(path.join(vault, ".git")));
  check("[1] (control) the parent repo's own history is untouched", commitCount(parentRepo) === 1);
  check(
    "[1] the skip is logged, naming the discovery failure (not silent)",
    warnings.some((w) => w.includes("[vault-versioner]") && w.includes("discovery check-is-repo failed")),
  );
}

// ═══ [2] NEGATIVE CONTROL: an ordinary NOT-a-repo vault (no bare-repo illusion) still inits + commits normally ═══
{
  const vault = path.join(root, "ordinary-no-repo-vault");
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, "note.md"), "# an ordinary new vault, no repo anywhere\n");

  const result = await commitVault(vault, "loom: first commit of a brand-new vault");
  check(
    "[2] negative control: an ordinary (non-illusory) not-a-repo vault still git-inits + commits",
    result.committed === true && commitCount(vault) === 1,
  );
}

// ═══ [3] THE OUTSIDE-VAULT PROBE (DoD-2), isolated from the discovery fail-closed fix above: even when
// discovery ITSELF cleanly reports "not a repo" (forced via an injected gitFactory, bypassing the bare-repo
// illusion entirely), a REAL enclosing repo one level up must still refuse the init. ═══
{
  const parentRepo = path.join(root, "parent3");
  initRepo(parentRepo);
  git(parentRepo, "commit", "--allow-empty", "-q", "-m", "init");
  const vault = path.join(parentRepo, "vault");
  fs.mkdirSync(vault, { recursive: true }); // deliberately NOT git-inited, no bare-repo illusion either

  // A gitFactory that forces checkIsRepo() to resolve to `false` CLEANLY whenever it's asked about `vault`
  // specifically (simulating a discovery step that reports "not a repo" with no error at all), while every
  // other repoPath (the outside-vault probe against `parentRepo`) goes through REAL simple-git untouched.
  const resolvedVault = path.resolve(vault);
  const gitFactory = (repoPath, blockMs) => {
    const real = simpleGit(repoPath, { timeout: { block: blockMs } });
    if (path.resolve(repoPath) === resolvedVault) {
      return {
        checkIsRepo: async () => false,
        revparse: (args) => real.revparse(args),
        init: () => real.init(),
        add: (p) => real.add(p),
        status: () => real.status(),
        commit: (m) => real.commit(m),
        raw: (args) => real.raw(args),
      };
    }
    return real;
  };

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  let result;
  try {
    result = await commitVault(vault, "loom: should be skipped (enclosing repo detected from outside)", {
      deps: { gitFactory },
    });
  } finally {
    console.warn = origWarn;
  }

  // (control, round 2 item 2) — same caveat as test [1]'s controls: these two would ALSO pass on the
  // parent repo (or on any unrelated skip reason), so they're sanity checks, not proof the outside-vault
  // probe mechanism specifically fired. The warning-text check below (naming the enclosing root) is proof.
  check("[3] (control) commitVault SKIPS when the outside-vault probe finds a real enclosing repo", result.committed === false);
  check("[3] NO nested .git was created inside the vault (outside probe fired before git init)", !fs.existsSync(path.join(vault, ".git")));
  check("[3] (control) the parent repo's own history is untouched", commitCount(parentRepo) === 1);
  check(
    "[3] the refusal is logged, naming the enclosing repo",
    warnings.some((w) => w.includes("[vault-versioner]") && w.includes("refusing to git init")),
  );
}

// ═══ [4] ROUND 2 — LOCALE PIN (DoD-1): both message-classified probes (discovery checkIsRepo, the
// outside-vault revparse) must carry LC_ALL=C/LANGUAGE=C, not just inherit the host locale. ═══
{
  const ENGLISH_NOT_A_REPO = "fatal: not a git repository (or any of the parent directories): .git";
  // A plausible French rendering of the same message — isNotAGitRepositoryError's pattern is English-only,
  // so this must NOT match it (proven as a standalone positive/negative control below).
  const LOCALIZED_NOT_A_REPO = "fatal : ceci n'est pas un dépôt git (ou l'un des répertoires parents) : .git";

  check("[4] (positive control) isNotAGitRepositoryError recognizes the English message", isNotAGitRepositoryError(new Error(ENGLISH_NOT_A_REPO)));
  check(
    "[4] (negative control) isNotAGitRepositoryError does NOT recognize a localized message — exactly the gap the locale pin closes",
    !isNotAGitRepositoryError(new Error(LOCALIZED_NOT_A_REPO)),
  );

  const localeRoot = path.join(root, "locale-test");
  const vault = path.join(localeRoot, "vault");
  fs.mkdirSync(vault, { recursive: true }); // genuinely not a repo; localeRoot isn't either — ordinary case
  fs.writeFileSync(path.join(vault, "note.md"), "# a vault under a simulated localized host\n");
  const resolvedVault = path.resolve(vault);
  const resolvedParent = path.resolve(localeRoot);

  // Captured INSIDE each returned method (not at factory-construction time): boundedVaultGitAtConfirmedRoot
  // re-invokes this SAME factory for vaultPath later (init/add/status/commit, with no env arg), which would
  // otherwise overwrite what discovery actually saw. checkIsRepo/revparse are each only ever CALLED once on
  // the object built for the real discovery/outside-probe request, so capturing inside them is safe.
  const capturedEnvs = { discovery: "unset", outside: "unset" };
  const localeAwareGitFactory = (repoPath, blockMs, env) => {
    const real = simpleGit(repoPath, { timeout: { block: blockMs } });
    const resolved = path.resolve(repoPath);
    const pinned = env?.LC_ALL === "C" && env?.LANGUAGE === "C";
    if (resolved === resolvedVault) {
      return {
        checkIsRepo: async () => {
          capturedEnvs.discovery = env;
          throw new Error(pinned ? ENGLISH_NOT_A_REPO : LOCALIZED_NOT_A_REPO);
        },
        revparse: (args) => real.revparse(args),
        init: () => real.init(),
        add: (p) => real.add(p),
        status: () => real.status(),
        commit: (m) => real.commit(m),
        raw: (args) => real.raw(args),
      };
    }
    if (resolved === resolvedParent) {
      return {
        checkIsRepo: (...a) => real.checkIsRepo(...a),
        revparse: async () => {
          capturedEnvs.outside = env;
          throw new Error(pinned ? ENGLISH_NOT_A_REPO : LOCALIZED_NOT_A_REPO);
        },
        init: () => real.init(),
        add: (p) => real.add(p),
        status: () => real.status(),
        commit: (m) => real.commit(m),
        raw: (args) => real.raw(args),
      };
    }
    return real;
  };

  const result = await commitVault(vault, "loom: first commit under a simulated localized host", {
    deps: { gitFactory: localeAwareGitFactory },
  });

  // THE PINNED PATH: both probes' git instances actually carry the locale pin — fails RED if either call
  // site stops passing env, or passes GIT_DIR/GIT_WORK_TREE instead of the locale-only override.
  check("[4] the discovery probe's git instance carries LC_ALL=C", capturedEnvs.discovery?.LC_ALL === "C");
  check("[4] the discovery probe's git instance carries LANGUAGE=C", capturedEnvs.discovery?.LANGUAGE === "C");
  check("[4] the discovery probe is NOT repo-pinned (no GIT_DIR)", capturedEnvs.discovery?.GIT_DIR === undefined);
  check("[4] the outside-vault probe's git instance carries LC_ALL=C", capturedEnvs.outside?.LC_ALL === "C");
  check("[4] the outside-vault probe's git instance carries LANGUAGE=C", capturedEnvs.outside?.LANGUAGE === "C");

  // THE LOCALIZED-REJECTION CASE: with the pin reaching both probes, each one's SIMULATED localized host
  // actually renders the RECOGNIZED English message (the whole point of pinning), so a genuinely-not-a-repo
  // vault still gets initialised — exactly the "never init on a non-English host" regression this closes.
  check(
    "[4] commitVault still inits + commits a genuinely-not-a-repo vault under a simulated localized host",
    result.committed === true && commitCount(vault) === 1,
  );
}

console.log(failures === 0
  ? "\nALL PASS — commitVault fails closed in discovery, refuses to nest a repo inside an enclosing one, and pins the locale on both message-classified probes."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
