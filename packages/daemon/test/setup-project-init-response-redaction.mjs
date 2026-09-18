import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ce9a3a91: `POST /api/setup/project-init` was the last known project-returning gateway response
// shipping `config.sessionEnv` unredacted — found by worker 19b09682 (flagged off its own 0c5d6851 work),
// then shown by the lead to leak on BOTH its exits, not the one originally named:
//   ~3350 — `reply.code(201).send({ ...project, identityWarning: identity.warning })` (the commit-identity
//           advisory branch, taken when the freshly-created repo has no resolvable git identity)
//   ~3352 — `reply.code(201).send(project)` (the plain path, no advisory)
// Sibling of project-write-response-redaction.mjs (card 0c5d6851, the other 4 project-returning WRITE
// routes) — same `redactSessionEnvForRead()` reuse, same assertion shape, DELIBERATELY a separate file
// (that file's own header scopes it to the four 0c5d6851 routes) rather than folding a 5th route in.
// This card's OWN drift-guard mechanism (project-response-redaction-drift-guard.mjs) is what stops a
// FUTURE 6th route/exit from needing yet another hand-written file like this one — this file is the
// ordinary behavioral regression test for the two exits this card actually fixed.
//
// Proves, per exit:
//   (1) kind:"vault" (skips the isGit branch entirely) exercises the PLAIN exit (~3352) — the response
//       masks a sessionEnv value supplied in the create payload, same length preserved, never the real
//       value, and the underlying STORED row keeps the real value (masking is response-only).
//   (2) kind:"git" (default) in this test's hermetic sandbox HOME (no gitconfig anywhere) triggers the
//       commit-identity WARNING branch (~3350) — the response carries BOTH the masked sessionEnv AND the
//       identityWarning field, proving the fix covers the branch that spreads `...project` alongside an
//       extra field, not just the simpler plain send.
//   (3) a project with no sessionEnv in the create payload round-trips with no sessionEnv key (the
//       masker's own early-return, not a crash) on both branches.
//
// Run: 1) build (turbo builds shared first), 2) node test/setup-project-init-response-redaction.mjs
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-setup-project-init-redact-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX — no .gitconfig anywhere under either, so a fresh `git
                                        // init`ed repo here has NO resolvable commit identity, which is
                                        // exactly what's needed to exercise the identityWarning branch.
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const stub = {};
const buildApp = (db) => buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

// Same predicate `redactSessionEnvForRead` is built to satisfy, checked from the outside through the real
// HTTP response — mirrors project-write-response-redaction.mjs's own `assertMasked`.
const assertMasked = (label, sessionEnv, name, realValue) => {
  const got = sessionEnv?.[name];
  check(`${label}: ${name} is present but never the real value`, typeof got === "string" && got !== realValue);
  check(`${label}: ${name} mask preserves the exact length (${realValue.length})`, got?.length === realValue.length);
};

const REAL_ALPHA = "alpha-project-init-secret-1234567890";

// ===================== (1) kind:"vault" — the PLAIN exit (~3352) =====================
{
  const db = new Db(path.join(TMP, "loom-vault.db"));
  const app = await buildApp(db);
  try {
    const r = await app.inject({
      method: "POST", url: "/api/setup/project-init",
      payload: { name: "Vault Secrets", kind: "vault", config: { sessionEnv: { ALPHA: REAL_ALPHA } } },
    });
    check("(1) POST kind:vault with sessionEnv → 201", r.statusCode === 201);
    const body = r.json();
    check("(1) response carries NO identityWarning (vault kind skips the isGit branch entirely)",
      body.identityWarning === undefined);
    assertMasked("(1) response", body.config.sessionEnv, "ALPHA", REAL_ALPHA);
    check("(1) ★ the STORED row keeps the REAL value (masking is response-only, never persisted)",
      db.getProject(body.id).config.sessionEnv.ALPHA === REAL_ALPHA);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (2) kind:"git" (default) — the identityWarning exit (~3350) =====================
{
  const db = new Db(path.join(TMP, "loom-git.db"));
  const app = await buildApp(db);
  try {
    const r = await app.inject({
      method: "POST", url: "/api/setup/project-init",
      payload: { name: "Git Secrets", config: { sessionEnv: { ALPHA: REAL_ALPHA } } },
    });
    check("(2) POST kind:git (default) with sessionEnv → 201", r.statusCode === 201);
    const body = r.json();
    // Load-bearing precondition: this exercise is only meaningful if the identityWarning branch (~3350)
    // actually fired — the hermetic sandbox HOME has no .gitconfig at any scope, so a freshly `git
    // init`ed repo here has no resolvable user.name/user.email. If this ever stops holding (e.g. a CI
    // runner injects a global gitconfig into the sandboxed HOME), this check fails LOUDLY rather than the
    // test silently degrading into a duplicate of (1).
    check("(2) ★ PRECONDITION: the commit-identity warning branch actually fired (typeof identityWarning === \"string\")",
      typeof body.identityWarning === "string" && body.identityWarning.length > 0);
    assertMasked("(2) response", body.config.sessionEnv, "ALPHA", REAL_ALPHA);
    check("(2) ★ the STORED row keeps the REAL value (masking is response-only, never persisted)",
      db.getProject(body.id).config.sessionEnv.ALPHA === REAL_ALPHA);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (3) no sessionEnv in the payload round-trips with no key, on both branches ======
{
  const db = new Db(path.join(TMP, "loom-bare.db"));
  const app = await buildApp(db);
  try {
    const vault = await app.inject({ method: "POST", url: "/api/setup/project-init", payload: { name: "Bare Vault", kind: "vault" } });
    check("(3) bare vault create → 201", vault.statusCode === 201);
    check("(3) ★ vault response carries no sessionEnv key (masker's early-return, not a crash)",
      vault.json().config.sessionEnv === undefined);

    const git = await app.inject({ method: "POST", url: "/api/setup/project-init", payload: { name: "Bare Git" } });
    check("(3) bare git create → 201", git.statusCode === 201);
    check("(3) ★ git response carries no sessionEnv key either",
      git.json().config.sessionEnv === undefined);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — POST /api/setup/project-init masks config.sessionEnv on BOTH response exits (the plain send and the identityWarning-carrying send), never the real value with the exact length preserved, the underlying stored row keeps the genuine secret (response-only masking), and a project with no sessionEnv round-trips with no sessionEnv key on either branch."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
