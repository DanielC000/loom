import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2a6a292a round 3 (MAJOR #2) — a HUMAN-only REST route to reset ONE (project, repoKey) mainline
// watermark: the exit for a deliberate IN-PLACE mainline rename, which resetMainlineBaselinesForRepoChange
// (a real repoPath change) can never reach. Same trust class as the git/vault writers: loopback, human-only,
// never an MCP tool.
//   (A) the route clears W + an undelivered boot-alert marker and files ONE mainline_moved_outside_loom
//       event, source:"human-reset", severity HIGH (an unread alert existed, carried as discardedAlert).
//   (B) a repoKey with no marker/W at all: a clean {reset:false} — not an error.
//   (C) refused (404) for an unknown project id.
//   (D) refused (404) for an unknown repoKey on a real project.
//   (E) "primary" always resolves even with no registered repos; a registered repo's own key resolves too.
//   (F)/(G) round 2 (card c013e8a5): an unparseable row carries a bounded raw excerpt (previousWatermarkRaw,
//       truncated to 200 chars) instead of previousWatermark, so a corrupt row's content isn't erased with
//       no trace at all.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject).
// Run: 1) build (pnpm build), 2) node test/mainline-watermark-reset-route.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mw-reset-route-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX

import { requireHermeticEnv } from "./_guard.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const MW = await import("../dist/git/mainline-watch.js");

const now = new Date().toISOString();
const repoPathStub = path.join(os.tmpdir(), `loom-mw-reset-route-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repoPathStub, { recursive: true });

try {
  const db = new Db(path.join(tmpHome, "mwreset.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
  try {
    db.insertProject({
      id: "pReset", name: "Reset", repoPath: repoPathStub, vaultPath: repoPathStub,
      config: {}, createdAt: now, archivedAt: null, reserved: false,
      repos: [{ key: "svc-a", path: repoPathStub }],
    });
    const mwEvents = () => db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === "pReset");
    const wKey = MW.mainlineWatermarkKey("pReset", "primary");
    const aKey = MW.mainlineBootAlertKey("pReset", "primary");

    // ── (A) an existing W + an UNDELIVERED marker ⇒ both cleared, ONE high event carrying the discarded alert ──
    db.setMeta(wKey, JSON.stringify({ branch: "renamed-main", sha: "a".repeat(40) }));
    db.setMeta(aKey, JSON.stringify({ branch: "renamed-main", from: "a".repeat(40), to: "a".repeat(40), evidence: ["branch-diverted"], suspectShas: ["a".repeat(40)], expectedBranch: "main", source: "landing", nudgedAt: null }));
    const resA = await app.inject({ method: "POST", url: "/api/projects/pReset/mainline-watermark/reset" });
    check("(A) 200 with {reset:true}", resA.statusCode === 200 && resA.json().reset === true);
    check("(A) W is gone", db.getMeta(wKey) === undefined);
    check("(A) the marker is gone", db.getMeta(aKey) === undefined);
    const evA = mwEvents();
    check("(A) exactly ONE event, source human-reset, severity high (the undelivered alert was discarded)", evA.length === 1 && evA[0].detail.source === "human-reset" && evA[0].detail.severity === "high" && evA[0].detail.reset === true);
    check("(A) the discarded alert's own evidence is carried on the event", evA[0].detail.discardedAlert?.evidence?.join() === "branch-diverted");
    // @decision c013e8a5 — the erased watermark itself is the only trace a reset adopted a stray branch.
    check("(A) the ERASED watermark is carried on the event as previousWatermark", evA[0].detail.previousWatermark?.branch === "renamed-main" && evA[0].detail.previousWatermark?.sha === "a".repeat(40));

    // ── (B) nothing to reset ⇒ a clean {reset:false}, no new event ──
    const resB = await app.inject({ method: "POST", url: "/api/projects/pReset/mainline-watermark/reset" });
    check("(B) nothing to reset: 200 with {reset:false}, not an error", resB.statusCode === 200 && resB.json().reset === false);
    check("(B) no new event filed for a no-op reset", mwEvents().length === 1);

    // ── (C) unknown project ⇒ 404 ──
    const resC = await app.inject({ method: "POST", url: "/api/projects/no-such-project/mainline-watermark/reset" });
    check("(C) unknown project id is refused with 404", resC.statusCode === 404);

    // ── (D) unknown repoKey on a real project ⇒ 404, and nothing is touched ──
    db.setMeta(wKey, JSON.stringify({ branch: "main", sha: "b".repeat(40) }));
    const resD = await app.inject({ method: "POST", url: "/api/projects/pReset/mainline-watermark/reset", payload: { repoKey: "no-such-repo" } });
    check("(D) an unknown repoKey is refused with 404", resD.statusCode === 404);
    check("(D) the primary watermark is untouched by the refused call", db.getMeta(wKey) !== undefined);

    // ── (E) "primary" (default) and a real registered repoKey both resolve ──
    const countBeforeE1 = mwEvents().length;
    const resE1 = await app.inject({ method: "POST", url: "/api/projects/pReset/mainline-watermark/reset" }); // no body ⇒ repoKey defaults to "primary"
    check("(E1) omitting repoKey resolves to primary and resets it", resE1.statusCode === 200 && resE1.json().reset === true && db.getMeta(wKey) === undefined);
    const evE1 = mwEvents().slice(countBeforeE1);
    check("(c013e8a5) (E1) previousWatermark carries the row this reset erased", evE1.length === 1 && evE1[0].detail.previousWatermark?.branch === "main" && evE1[0].detail.previousWatermark?.sha === "b".repeat(40));
    const wKeySvcA = MW.mainlineWatermarkKey("pReset", "svc-a");
    db.setMeta(wKeySvcA, JSON.stringify({ branch: "main", sha: "c".repeat(40) }));
    const resE2 = await app.inject({ method: "POST", url: "/api/projects/pReset/mainline-watermark/reset", payload: { repoKey: "svc-a" } });
    check("(E2) a real registered repo's own key resolves and resets ONLY that key", resE2.statusCode === 200 && resE2.json().reset === true && db.getMeta(wKeySvcA) === undefined);

    // ── (F) the watermark row is present but UNPARSEABLE ⇒ previousWatermark is OMITTED (nothing valid to
    //     report), but round 2 (card c013e8a5) carries a bounded RAW excerpt instead, so the corrupt
    //     content isn't erased with no trace at all ──
    const corruptRaw = "this is not json at all";
    db.setMeta(wKey, corruptRaw);
    const countBeforeF = mwEvents().length;
    const resF = await app.inject({ method: "POST", url: "/api/projects/pReset/mainline-watermark/reset" });
    check("(c013e8a5) (F) a corrupt row still resets cleanly", resF.statusCode === 200 && resF.json().reset === true && db.getMeta(wKey) === undefined);
    const evF = mwEvents().slice(countBeforeF);
    check("(c013e8a5) (F) previousWatermark is OMITTED for an unparseable row — nothing valid to report", evF.length === 1 && !("previousWatermark" in evF[0].detail));
    check("(c013e8a5 r2) (F) previousWatermarkRaw carries the corrupt row's own raw bytes instead", evF[0].detail.previousWatermarkRaw === corruptRaw);

    // ── (G) an unparseable row LONGER than the 200-char bound ⇒ previousWatermarkRaw is TRUNCATED, never
    //     carried whole (round 2, card c013e8a5) ──
    const longCorruptRaw = "x".repeat(250);
    db.setMeta(wKey, longCorruptRaw);
    const countBeforeG = mwEvents().length;
    const resG = await app.inject({ method: "POST", url: "/api/projects/pReset/mainline-watermark/reset" });
    check("(c013e8a5 r2) (G) a long corrupt row still resets cleanly", resG.statusCode === 200 && resG.json().reset === true);
    const evG = mwEvents().slice(countBeforeG);
    check("(c013e8a5 r2) (G) previousWatermarkRaw is truncated to 200 chars, never the whole 250-char row", evG.length === 1 && evG[0].detail.previousWatermarkRaw === longCorruptRaw.slice(0, 200) && evG[0].detail.previousWatermarkRaw.length === 200);
  } finally {
    db.close();
  }
} finally {
  for (const d of [tmpHome, repoPathStub]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the human-only mainline-watermark reset route clears W + an undelivered marker, audits a human-reset event (HIGH when it discards an unread alert, previousWatermark/previousWatermarkRaw carrying the erased row), is a clean no-op when there is nothing to reset, and refuses an unknown project or repoKey."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
