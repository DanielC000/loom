import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1718416d — argv/env/cwd fidelity for win-job-launcher.exe. The launcher REBUILDS git's Windows
// command line from its own argv (native/win-job-launcher/launcher.cs's QuoteWindowsArg) — "a classic
// bug source" per the kickoff, so this compares the REAL STORED RESULT of running an operation through
// the launcher against running the SAME operation via bare git directly, for a corpus of adversarial
// argv shapes (spaces, embedded quotes, trailing backslashes, backslash+quote runs, an empty-string
// arg, non-ASCII/UTF-16), plus a GIT_* env var and a non-ASCII cwd. Comparing STORED values (read back
// via `git log`) rather than only "did it exit 0" is deliberate — a quoting bug can corrupt the VALUE
// while git still exits cleanly.
// WINDOWS-ONLY, requires build:native. Full mechanism: docs/decisions/1718416d-win-job-launcher-containment.md.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

if (process.platform !== "win32") {
  console.log("SKIP  win-job-launcher-fidelity — win32-only (this host is '" + process.platform + "').");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXE = path.join(__dirname, "..", "assets", "native", "win-job-launcher.exe");
if (!fs.existsSync(EXE)) {
  console.log("SKIP  win-job-launcher-fidelity — win-job-launcher.exe not built. Run `pnpm --filter @loom/daemon build:native` first.");
  process.exit(0);
}

// Card 5b50eede: the launcher's argv now carries a resolved absolute git.exe path as args[2] — imported
// from the compiled resolver (the SAME one bounded.ts uses) rather than a second hand-rolled PATH walk.
const { resolveExecutable } = await import(pathToFileURL(path.join(__dirname, "..", "dist", "pty", "resolve-bin.js")).href);
const GIT_EXE = resolveExecutable("git");
if (GIT_EXE === "git" || !/\.exe$/i.test(GIT_EXE)) {
  console.log(`SKIP  win-job-launcher-fidelity — could not resolve an absolute git.exe on PATH (got ${JSON.stringify(GIT_EXE)}).`);
  process.exit(0);
}

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (detail) console.log(`   ${detail}`); }
};

function makeRepo(tag) {
  const repo = mkdtempManaged(`loom-wjl-fidelity-${tag}-`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "wjl@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "wjl"], { cwd: repo });
  return repo;
}

function runLauncher(repo, nonce, args, env) {
  return new Promise((resolve) => {
    const child = spawn(EXE, ["run", nonce, GIT_EXE, ...args], { cwd: repo, windowsHide: true, env: env ?? process.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function bareGitExitAndOut(repo, args, env) {
  try {
    const out = execFileSync("git", args, { cwd: repo, encoding: "utf8", env: env ?? process.env });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

// --- Corpus: argv fidelity via commit message round-trip (git log --format=%B%x00, read back verbatim).
const ARGV_CASES = [
  ["spaces", "a value with several spaces in it"],
  ["embedded double quotes", 'a "quoted" value'],
  ["trailing backslash", "a value ending in\\"],
  ["backslash+quote run", 'a\\"value\\\\with\\"runs'],
  ["multiple trailing backslashes", "C:\\some\\path\\\\"],
  ["empty string", ""],
  ["non-ASCII (UTF-16, surrogate pairs + CJK + accents)", "héllo 世界 🎉 — café"],
];

async function run() {
  for (const [label, value] of ARGV_CASES) {
    const repoBare = makeRepo(`bare-${label.replace(/\W+/g, "_")}`);
    const repoLauncher = makeRepo(`launcher-${label.replace(/\W+/g, "_")}`);
    const nonce = crypto.randomBytes(16).toString("hex");

    const commitArgs = value === ""
      ? ["commit", "--allow-empty", "--allow-empty-message", "-m", value]
      : ["commit", "--allow-empty", "-m", value];

    const bare = bareGitExitAndOut(repoBare, commitArgs);
    const viaLauncher = await runLauncher(repoLauncher, nonce, commitArgs);

    check(`argv fidelity [${label}]: bare git accepted it (sanity — exit 0)`, bare.code === 0, bare.out);
    check(`argv fidelity [${label}]: launcher-spawned git exited the same way (0)`, viaLauncher.code === 0, JSON.stringify(viaLauncher));

    if (bare.code === 0 && viaLauncher.code === 0) {
      // `%B` itself stores a trailing newline for a single-line message, and `git log` appends its own
      // on top — trimEnd() (not a single-newline replace) strips both uniformly; none of this corpus's
      // values end in meaningful whitespace, so this is safe here.
      const storedBare = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: repoBare, encoding: "utf8" }).trimEnd();
      const storedLauncher = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: repoLauncher, encoding: "utf8" }).trimEnd();
      check(`argv fidelity [${label}]: stored commit message is BYTE-IDENTICAL between bare git and the launcher`,
        storedLauncher === storedBare,
        `bare=${JSON.stringify(storedBare)} launcher=${JSON.stringify(storedLauncher)}`);
      check(`argv fidelity [${label}]: stored value matches the INTENDED input (bare git itself round-trips correctly — a control on the comparison, not just the launcher)`,
        storedBare === value, `expected=${JSON.stringify(value)} got=${JSON.stringify(storedBare)}`);
    }
  }

  // --- env fidelity: a GIT_* env var (GIT_AUTHOR_NAME/EMAIL), inherited exactly.
  {
    const repoBare = makeRepo("env-bare");
    const repoLauncher = makeRepo("env-launcher");
    const nonce = crypto.randomBytes(16).toString("hex");
    const env = { ...process.env, GIT_AUTHOR_NAME: "EnvFidelityAuthor", GIT_AUTHOR_EMAIL: "env-fidelity@loom.test" };

    const bare = bareGitExitAndOut(repoBare, ["commit", "--allow-empty", "-m", "env case"], env);
    const viaLauncher = await runLauncher(repoLauncher, nonce, ["commit", "--allow-empty", "-m", "env case"], env);
    check("env fidelity: bare git accepted GIT_AUTHOR_* env (sanity)", bare.code === 0, bare.out);
    check("env fidelity: launcher-spawned git exited 0 with the same env", viaLauncher.code === 0, JSON.stringify(viaLauncher));
    if (bare.code === 0 && viaLauncher.code === 0) {
      const authorBare = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: repoBare, encoding: "utf8" }).trim();
      const authorLauncher = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: repoLauncher, encoding: "utf8" }).trim();
      check("env fidelity: GIT_AUTHOR_NAME/EMAIL reached git identically through the launcher",
        authorLauncher === authorBare && authorLauncher === "EnvFidelityAuthor <env-fidelity@loom.test>",
        `bare=${authorBare} launcher=${authorLauncher}`);
    }
  }

  // --- cwd fidelity: a non-ASCII directory name.
  {
    const parent = mkdtempManaged("loom-wjl-fidelity-cwd-");
    const nonAsciiDir = path.join(parent, "tëst-üñïcode-目录");
    fs.mkdirSync(nonAsciiDir);
    execFileSync("git", ["init", "-q"], { cwd: nonAsciiDir });
    execFileSync("git", ["config", "user.email", "wjl@loom"], { cwd: nonAsciiDir });
    execFileSync("git", ["config", "user.name", "wjl"], { cwd: nonAsciiDir });
    const nonce = crypto.randomBytes(16).toString("hex");
    const viaLauncher = await runLauncher(nonAsciiDir, nonce, ["commit", "--allow-empty", "-m", "cwd case"]);
    check("cwd fidelity: launcher-spawned git ran correctly in a non-ASCII cwd", viaLauncher.code === 0, JSON.stringify(viaLauncher));
    if (viaLauncher.code === 0) {
      const log = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: nonAsciiDir, encoding: "utf8" }).trim();
      check("cwd fidelity: commit actually landed in the non-ASCII directory", log === "cwd case");
    }
  }

  console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
