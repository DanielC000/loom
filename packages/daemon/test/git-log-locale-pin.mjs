import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 274ff336 (manager review round 2): GitReader.log()'s commitless-repo detection MUST hold
// regardless of the host's git locale, or the fix regresses on any non-English host — invisible to
// every test on an English CI box, exactly like the original 500 was invisible until a real onboarding
// flow hit it.
//
// Two independent lines of defence, both proven here:
//   (a) STRUCTURAL primary check — `git rev-parse --quiet --verify HEAD` is exit-code-based (--quiet
//       suppresses stderr), so it can never be fooled by a localized message in the first place.
//   (b) LOCALE PIN — GitReader wires `nonInteractiveEnv()` (LC_ALL=C/LANG=C, the SAME convention
//       git/writer.ts already established — see its comment at writer.ts:45-49) onto its own git
//       instance, as defence-in-depth for the message-match FALLBACK behind (a).
//
// This box's git (Git for Windows) ships with no gettext translation catalogs, so setting LC_ALL to a
// non-English locale does NOT actually change git's fatal-message text here (verified empirically —
// `LC_ALL=de_DE.UTF-8 git log` on a commitless repo still prints the English message). A live
// localized-round-trip test therefore can't exercise the failure mode on this host — so, per the
// review's explicit fallback, this proves the MECHANISM instead:
//   (1) `nonInteractiveEnv()` overrides an INHERITED foreign LC_ALL/LANG to "C" — the exact override
//       writer.ts's comment describes ("LC_ALL wins over any inherited LANG/LC_*"), exercised against a
//       real foreign value set on this very process, not a hardcoded literal.
//   (2) a WIRING guard — GitReader's compiled source actually calls `.env(nonInteractiveEnv())` — so a
//       regression that quietly drops that call (while `nonInteractiveEnv()` itself stays correct
//       elsewhere) is still caught.
//   (3) an end-to-end sanity pass with the process's OWN LC_ALL/LANG temporarily set to a foreign value —
//       the commitless-repo routes still return a clean empty log. This can't by itself DISPROVE a
//       locale regression on this host (git here doesn't localize either way — see above), but it does
//       confirm nothing in the request path is destabilized by a foreign host locale being present.
//
// Run: 1) build (turbo builds shared first), 2) node test/git-log-locale-pin.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-gitlog-locale-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45324";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");

// --- (1) nonInteractiveEnv() overrides an INHERITED foreign locale, not just a clean one. ---
const savedLcAll = process.env.LC_ALL;
const savedLang = process.env.LANG;
process.env.LC_ALL = "de_DE.UTF-8";
process.env.LANG = "de_DE.UTF-8";
try {
  const env = nonInteractiveEnv();
  check("(1) nonInteractiveEnv() pins LC_ALL=C even with a foreign LC_ALL inherited", env.LC_ALL === "C");
  check("(1) nonInteractiveEnv() pins LANG=C even with a foreign LANG inherited", env.LANG === "C");
} finally {
  if (savedLcAll === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = savedLcAll;
  if (savedLang === undefined) delete process.env.LANG; else process.env.LANG = savedLang;
}

// --- (2) WIRING guard — GitReader's compiled output actually applies the pin, not just defines it. ---
const readerSrc = fs.readFileSync(new URL("../dist/git/reader.js", import.meta.url), "utf8");
check("(2) GitReader imports nonInteractiveEnv from writer.js", /nonInteractiveEnv/.test(readerSrc));
check("(2) GitReader applies it via .env(nonInteractiveEnv())", /\.env\(\s*nonInteractiveEnv\(\)\s*\)/.test(readerSrc));

// --- (3) End-to-end sanity: commitless-repo routes still return a clean empty log with a FOREIGN host
// locale set on the test process for the duration of the request. ---
const commitlessRepo = path.join(os.tmpdir(), `loom-gitlog-locale-empty-${Date.now()}-${process.pid}`);
fs.mkdirSync(commitlessRepo, { recursive: true });
execSync("git init -q", { cwd: commitlessRepo });
const now = new Date().toISOString();

try {
  const db = new Db(path.join(tmpHome, "gitlog-locale.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
  try {
    db.insertProject({
      id: "pCommitlessLocale", name: "CommitlessLocale", repoPath: commitlessRepo, vaultPath: commitlessRepo,
      config: {}, createdAt: now, archivedAt: null, reserved: false,
      referenceRepos: [commitlessRepo], repos: [{ key: "svc", path: commitlessRepo }],
    });

    process.env.LC_ALL = "fr_FR.UTF-8";
    process.env.LANG = "fr_FR.UTF-8";
    try {
      const primary = await app.inject({ method: "GET", url: "/api/projects/pCommitlessLocale/git/log" });
      check("(3) primary log still 200 under a foreign host locale", primary.statusCode === 200);
      check("(3) primary log still returns an empty array", Array.isArray(primary.json()) && primary.json().length === 0);

      const ref = await app.inject({ method: "GET", url: "/api/projects/pCommitlessLocale/git/reference-repos/0/log" });
      check("(3) reference-repo log still 200 under a foreign host locale", ref.statusCode === 200);

      const registry = await app.inject({ method: "GET", url: "/api/projects/pCommitlessLocale/git/repos/0/log" });
      check("(3) registered-repo log still 200 under a foreign host locale", registry.statusCode === 200);
    } finally {
      if (savedLcAll === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = savedLcAll;
      if (savedLang === undefined) delete process.env.LANG; else process.env.LANG = savedLang;
    }
  } finally {
    db.close();
  }
} finally {
  for (const d of [tmpHome, commitlessRepo]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — nonInteractiveEnv() overrides an inherited foreign LC_ALL/LANG to C (the actual override behavior, not a hardcoded literal), GitReader's compiled output is confirmed WIRED to apply it, and the commitless-repo routes stay clean under a foreign host locale for the duration of a request; claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
