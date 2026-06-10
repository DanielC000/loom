// Unit test for the git WRITER's host↔identity mismatch WARNING on push(). Claude-free: imports the
// compiled module and runs real git on temp repos + bare local remotes (no network). Proves:
//   - self-hosted origin + GitHub-noreply identity → warning
//   - GitHub origin + real (non-noreply) identity → warning
//   - matched cases (GitHub+noreply, self-hosted+real) → NO warning
//   - host parsing across scp-like (git@host:path) and scheme (https://, ssh://) forms
//   - FAIL-SAFE: a detection error (no origin) yields NO warning and NEVER blocks the push
// Run after build: node test/git-identity-warning.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitWriter } from "../dist/git/writer.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-git-id-warn-")));

// Build a fresh repo with the given commit identity. The branch tracks a REAL bare remote ("upstream")
// so the writer's plain `git push` succeeds offline; `origin` is set to the host-under-test URL purely
// for detection (the writer reads `git remote get-url origin` but never pushes to it — plain push
// follows the branch's tracked upstream). originUrl=null leaves NO origin (the fail-safe case).
// Returns { repo, writer, branch }.
function makeRepo(name, { email, originUrl }) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init");
  git("config", "user.email", email);
  git("config", "user.name", "loom-test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
  // Real bare remote the branch TRACKS — plain push goes here and succeeds, no network.
  const bare = path.join(root, `${name}.git`);
  execFileSync("git", ["init", "--bare", bare], { stdio: ["ignore", "pipe", "pipe"] });
  git("remote", "add", "upstream", bare);
  git("push", "-u", "upstream", branch);
  // `origin` carries ONLY the host-under-test URL for detection — never pushed to.
  if (originUrl) git("remote", "add", "origin", originUrl);
  // A second commit to push (the first is already on the tracked remote).
  fs.writeFileSync(path.join(repo, "more.txt"), "more\n");
  git("add", "-A");
  git("commit", "-m", "second");
  return { repo, writer: new GitWriter(repo), branch, bare };
}

try {
  // 1. SELF-HOSTED origin (Forgejo, scp-like SSH URL) + GitHub-noreply identity → WARN.
  {
    const { writer, branch } = makeRepo("forgejo-noreply", {
      email: "12345+daniel@users.noreply.github.com",
      originUrl: "git@forgejo.example.com:daniel/loom.git",
    });
    const r = await writer.push();
    check("self-hosted+noreply: push succeeds (never blocked)", r.ok === true && r.branch === branch);
    check("self-hosted+noreply: warning surfaced", typeof r.warning === "string" && /unroutable/i.test(r.warning));
  }

  // 2. GITHUB origin (https) + real (non-noreply) identity → WARN about leaking the address.
  {
    const { writer } = makeRepo("github-real", {
      email: "daniel@gmail.com",
      originUrl: "https://github.com/daniel/loom.git",
    });
    const r = await writer.push();
    check("github+real: push succeeds", r.ok === true);
    check("github+real: warning surfaced", typeof r.warning === "string" && /leak/i.test(r.warning));
  }

  // 3. MATCHED: GitHub origin + GitHub-noreply identity → NO warning.
  {
    const { writer } = makeRepo("github-noreply", {
      email: "12345+daniel@users.noreply.github.com",
      originUrl: "https://github.com/daniel/loom.git",
    });
    const r = await writer.push();
    check("github+noreply: push succeeds", r.ok === true);
    check("github+noreply: NO warning (matched)", r.warning === undefined);
  }

  // 4. MATCHED: self-hosted origin + real identity → NO warning.
  {
    const { writer } = makeRepo("forgejo-real", {
      email: "daniel@gmail.com",
      originUrl: "ssh://git@git.example.com:2222/daniel/loom.git",
    });
    const r = await writer.push();
    check("self-hosted+real: push succeeds", r.ok === true);
    check("self-hosted+real: NO warning (matched)", r.warning === undefined);
  }

  // 5. GitHub SUBDOMAIN host counts as GitHub (gist.github.com) — real identity → WARN.
  {
    const { writer } = makeRepo("gist-real", {
      email: "daniel@gmail.com",
      originUrl: "git@gist.github.com:daniel/loom.git",
    });
    const r = await writer.push();
    check("github subdomain treated as GitHub → warns on real email", r.ok === true && typeof r.warning === "string");
  }

  // 6. GitHub-Enterprise-style self-hosted host (github.example.com — NOT a github.com subdomain) +
  //    noreply identity → WARN (it is self-hosted; only *.github.com is GitHub).
  {
    const { writer } = makeRepo("ghe-noreply", {
      email: "12345+daniel@users.noreply.github.com",
      originUrl: "https://github.example.com/daniel/loom.git",
    });
    const r = await writer.push();
    check("github.example.com is self-hosted (not GitHub) → warns on noreply", r.ok === true && typeof r.warning === "string");
  }

  // 7. FAIL-SAFE: NO origin remote at all (branch tracks "upstream") → `git remote get-url origin`
  //    errors → identityWarning swallows it → NO warning, push still publishes. Identity is a noreply
  //    so a working detection WOULD have to decide; proving none is emitted shows the error is swallowed.
  {
    const { writer, branch } = makeRepo("no-origin", {
      email: "12345+daniel@users.noreply.github.com",
      originUrl: null,
    });
    const r = await writer.push();
    check("no-origin: push still succeeds (detection failure never blocks)", r.ok === true && r.branch === branch);
    check("no-origin: NO warning on detection error (fail-safe)", r.warning === undefined);
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry */ } }
}

console.log(failures === 0 ? "\nALL PASS — host↔identity mismatch warning + fail-safe hold." : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
