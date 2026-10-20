import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Inbox attachment serving (card 8f050b79, child 2 of epic 7d1d66ab) — GET
// /api/questions/:id/attachments/:attachmentId + POST .../opened. HERMETIC + CLAUDE-FREE + NETWORK-FREE
// (Db + buildServer via app.inject, same pattern as vault-raw.mjs / loopback-write-guard.mjs). Proves:
//   (1) per-kind headers: html → CSP `sandbox allow-scripts; form-action 'none'; connect-src 'none'` +
//       nosniff + no-referrer + NO Content-Disposition; image → nosniff + no-referrer +
//       `sandbox; default-src 'none'` + NO Content-Disposition; other (including a stored .svg, which
//       `deriveAttachmentKind` already classifies "other" at copy time, card 432765ab) →
//       Content-Disposition: attachment (RFC 5987 + ASCII fallback) + `sandbox; default-src 'none'`.
//       EVERY response carries SOME sandbox CSP now (Code Review round 1) — never none.
//   (1b) the CSP is derived from the SERVED Content-Type (via `isActiveDocumentContentType`), never from
//       `record.kind`: a TAMPERED row (kind:"image", storedFilename ending ".html") still gets the HTML
//       sandbox policy, because that's what will actually be served and rendered.
//   (2) id-shape validation: a malformed questionId/attachmentId 400s BEFORE any DB/fs access.
//   (3) missing store file → 404 with {available:false}.
//   (4) realpath containment (manager condition 1, defence in depth): a DB row whose storedFilename
//       escapes the question's own store dir is refused (404), and the escaped file's real content never
//       reaches the response body.
//   (5) Content-Disposition header-injection hardening: a label containing CR/LF/quotes never produces a
//       raw CR/LF byte in the emitted header value.
//   (6) openedAt: first-open-wins, atomic — a second POST returns the ORIGINAL stamp unchanged.
//   (7) the POST route is swept into the loopback-secret bearer guard automatically (manager condition 1):
//       401 with no/wrong credential, reaches the real handler with the correct one.
//   (8) the Origin/CORS verification this card's own decision record cites (manager condition 2),
//       exercised against these TWO NEW routes specifically: a sandboxed-iframe-shaped `Origin: null` is
//       403'd by the pre-existing CSRF hook (not by anything this card added), and no response ever
//       carries an Access-Control-Allow-Origin header.
//   (9) routeTier: both new routes (GET + its HEAD sibling + POST) are Tier-1, matching the sibling
//       Requests routes.
//   (10) a junction/symlink subdir planted INSIDE the store, pointing OUTSIDE it, must not escape the
//       containment check either (skips gracefully if junction creation is denied).
//   (11) a malformed id on the POST .../opened route 400s too, same as the GET route.
// Run after build: node test/question-attachment-serving.mjs
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-attach-serve-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const PORT = process.env.LOOM_PORT;
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { routeTier } = await import("../dist/gateway/trust-tier.js");
const { questionAttachmentDir } = await import("../dist/paths.js");
const { resolveStoredAttachmentFile, attachmentContentDisposition } = await import("../dist/mcp/attachments.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Loopback headers so the CSRF/DNS-rebind onRequest hook lets the request through to the handler
// (mirrors loopback-write-guard.mjs exactly).
const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
const authH = (bearer) => (bearer ? { ...H, authorization: `Bearer ${bearer}` } : H);

const now = new Date().toISOString();
const stub = {};
const buildApp = (deps) => buildServer({
  db: deps.db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, ...deps.extra,
});

const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "p1", name: "P1", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agent1", projectId: "p1", name: "Manager", startupPrompt: "BRIEF", position: 0 });
db.insertSession({
  id: "mgr1", projectId: "p1", agentId: "agent1", engineSessionId: "eng-mgr1", title: null, cwd: "p1",
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});

const baseQuestion = (id) => ({
  id, sessionId: "mgr1", filedBySessionId: "mgr1", projectId: "p1", type: "decision",
  title: "Review this", body: "see attached",
  options: ["approve", "reject"], recommendation: null, taskId: null,
  permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null,
  decidedScope: null, decidedExpiresAt: null, credentialEnvVar: null, credentialByteLength: null,
  provisionTarget: null, fulfillmentTarget: null, provisionConnectionId: null, provisionBindingState: "none",
  state: "pending", chosenOption: null, note: null,
  createdAt: now, answeredAt: null, consumedAt: null,
  cancelledReason: null, cancelledBy: null, cancelledAt: null,
  escalatedAt: null, acknowledgedUntil: null, readAt: null,
  attachments: [],
});

// --- question "q1": one of each real kind ----------------------------------------------------------
const q1 = "11111111-1111-4111-8111-111111111111";
const q1Dir = questionAttachmentDir(q1);
fs.mkdirSync(q1Dir, { recursive: true });

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
fs.writeFileSync(path.join(q1Dir, "0-pic.png"), PNG_BYTES);

const EVIL_HTML = `<!doctype html><html><body><script>document.title = "PWNED:" + JSON.stringify(window.localStorage);</script>`
  + `<button onclick="document.title='clicked'">switch scenario</button></body></html>`;
fs.writeFileSync(path.join(q1Dir, "1-mockup.html"), EVIL_HTML);

// A stored .svg — deriveAttachmentKind (card 432765ab) classifies this "other" at copy time (SVG is
// deliberately NOT in IMAGE_EXTENSIONS), so this route must treat it exactly like any other download.
const EVIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>`;
fs.writeFileSync(path.join(q1Dir, "2-evil.svg"), EVIL_SVG);

// Code Review round 1's own probe: a TAMPERED row claiming kind:"image" whose storedFilename is
// actually ".html" — the CSP must track what's REALLY served (text/html, scriptable), not the claimed
// kind, or this ships a real scriptable document with no sandbox CSP at all.
const TAMPER_HTML = `<!doctype html><html><body><script>document.title = "TAMPER-PWNED";</script></body></html>`;
fs.writeFileSync(path.join(q1Dir, "3-tamper.html"), TAMPER_HTML);

const q1Attachments = [
  { id: "0", label: "Screenshot.png", kind: "image", sizeBytes: PNG_BYTES.length, imageDimensions: { width: 1, height: 1 }, storedFilename: "0-pic.png", originalPath: "C:\\secret\\0-pic.png", openedAt: null },
  { id: "1", label: "Mockup.html", kind: "html", sizeBytes: EVIL_HTML.length, imageDimensions: null, storedFilename: "1-mockup.html", originalPath: "C:\\secret\\1-mockup.html", openedAt: null },
  { id: "2", label: 'evil"; \r\nX-Injected: yes.svg', kind: "other", sizeBytes: EVIL_SVG.length, imageDimensions: null, storedFilename: "2-evil.svg", originalPath: "C:\\secret\\2-evil.svg", openedAt: null },
  { id: "3", label: "Tampered.png", kind: "image", sizeBytes: TAMPER_HTML.length, imageDimensions: null, storedFilename: "3-tamper.html", originalPath: "C:\\secret\\3-tamper.html", openedAt: null },
];
db.insertQuestion(baseQuestion(q1), q1Attachments);

// --- question "q2": a record whose store file is MISSING on disk (never written) --------------------
const q2 = "22222222-2222-4222-8222-222222222222";
db.insertQuestion(baseQuestion(q2), [
  { id: "0", label: "Gone.png", kind: "image", sizeBytes: 10, imageDimensions: null, storedFilename: "0-gone.png", originalPath: "C:\\secret\\0-gone.png", openedAt: null },
]);

// --- question "q3": a MALICIOUS stored record whose storedFilename escapes its own store dir ---------
// (defence in depth, manager condition 1 — storedFilename is normally daemon-written and can never
// actually look like this; this simulates DB tampering / a future bug upstream of this route.)
const q3 = "33333333-3333-4333-8333-333333333333";
const OUTSIDE_SECRET = path.join(TMP, "outside-secret.txt");
fs.writeFileSync(OUTSIDE_SECRET, "TOP SECRET — outside the attachment store\n");
db.insertQuestion(baseQuestion(q3), [
  { id: "0", label: "Escape.txt", kind: "other", sizeBytes: 5, imageDimensions: null, storedFilename: "../../outside-secret.txt", originalPath: "C:\\secret\\escape.txt", openedAt: null },
]);

const app = await buildApp({ db });
const get = (url, headers = H) => app.inject({ method: "GET", url, headers });
const post = (url, headers = H) => app.inject({ method: "POST", url, headers, payload: {} });

try {
  // ===================== (1) per-kind headers =====================
  const SANDBOX_CSP_INERT = "sandbox; default-src 'none'";
  const SANDBOX_CSP_HTML = "sandbox allow-scripts; form-action 'none'; connect-src 'none'";

  const img = await get(`/api/questions/${q1}/attachments/0`);
  check("(1-image) 200", img.statusCode === 200);
  check("(1-image) Content-Type image/png", img.headers["content-type"] === "image/png");
  check("(1-image) nosniff", img.headers["x-content-type-options"] === "nosniff");
  check("(1-image) no-referrer", img.headers["referrer-policy"] === "no-referrer");
  check(`(1-image) CSP: ${SANDBOX_CSP_INERT}`, img.headers["content-security-policy"] === SANDBOX_CSP_INERT);
  check("(1-image) NO Content-Disposition (served inline)", img.headers["content-disposition"] === undefined);
  check("(1-image) body byte-matches the fixture", Buffer.compare(img.rawPayload, PNG_BYTES) === 0);

  const html = await get(`/api/questions/${q1}/attachments/1`);
  check("(1-html) 200", html.statusCode === 200);
  check("(1-html) Content-Type text/html; charset=utf-8", html.headers["content-type"] === "text/html; charset=utf-8");
  check(`(1-html) CSP: ${SANDBOX_CSP_HTML}`, html.headers["content-security-policy"] === SANDBOX_CSP_HTML);
  check("(1-html) nosniff", html.headers["x-content-type-options"] === "nosniff");
  check("(1-html) no-referrer", html.headers["referrer-policy"] === "no-referrer");
  check("(1-html) NO Content-Disposition (served as a document)", html.headers["content-disposition"] === undefined);
  check("(1-html) body is served byte-exact (the guard is headers, not rewriting)", html.rawPayload.toString("utf8") === EVIL_HTML);

  const other = await get(`/api/questions/${q1}/attachments/2`);
  check("(1-other/svg) 200", other.statusCode === 200);
  check("(1-other/svg) Content-Disposition: attachment present", /^attachment;/.test(other.headers["content-disposition"] ?? ""));
  check(`(1-other/svg) CSP: ${SANDBOX_CSP_INERT}`, other.headers["content-security-policy"] === SANDBOX_CSP_INERT);
  check("(1-other/svg) nosniff", other.headers["x-content-type-options"] === "nosniff");
  check("(1-other/svg) Content-Type is NOT image/svg+xml (no inline-render path exists for it)", other.headers["content-type"] !== "image/svg+xml");
  check("(1-other/svg) body is served byte-exact", other.rawPayload.toString("utf8") === EVIL_SVG);

  // ===================== (1b) the CSP tracks the SERVED type, never record.kind =====================
  const tampered = await get(`/api/questions/${q1}/attachments/3`);
  check("(1b-tamper) 200", tampered.statusCode === 200);
  check("(1b-tamper) Content-Type follows the REAL extension (text/html), not the claimed kind:\"image\"",
    tampered.headers["content-type"] === "text/html; charset=utf-8");
  check(`(1b-tamper) CSP: ${SANDBOX_CSP_HTML} — the HTML sandbox policy, matching what's ACTUALLY served, not the claimed kind`,
    tampered.headers["content-security-policy"] === SANDBOX_CSP_HTML);
  check("(1b-tamper) body served byte-exact", tampered.rawPayload.toString("utf8") === TAMPER_HTML);

  // ===================== (2) id-shape validation, BEFORE any DB/fs access =====================
  check("(2) malformed questionId → 400", (await get(`/api/questions/${encodeURIComponent("../x")}/attachments/0`)).statusCode === 400);
  check("(2) malformed attachmentId → 400", (await get(`/api/questions/${q1}/attachments/${encodeURIComponent("../x")}`)).statusCode === 400);
  check("(2) non-numeric attachmentId → 400", (await get(`/api/questions/${q1}/attachments/abc`)).statusCode === 400);
  check("(2) a well-formed-looking but non-UUID questionId → 400", (await get(`/api/questions/not-a-uuid/attachments/0`)).statusCode === 400);
  // (11) the POST route validates ids BEFORE any DB/fs access too — same shape as the GET route.
  check("(11) malformed questionId on POST .../opened → 400", (await post(`/api/questions/${encodeURIComponent("../x")}/attachments/0/opened`)).statusCode === 400);
  check("(11) malformed attachmentId on POST .../opened → 400", (await post(`/api/questions/${q1}/attachments/${encodeURIComponent("../x")}/opened`)).statusCode === 400);
  check("(11) non-UUID questionId on POST .../opened → 400", (await post(`/api/questions/not-a-uuid/attachments/0/opened`)).statusCode === 400);

  // ===================== (3) missing store file → 404 + available:false =====================
  const missing = await get(`/api/questions/${q2}/attachments/0`);
  check("(3) missing store file → 404", missing.statusCode === 404);
  check("(3) 404 body carries available:false", missing.json().available === false);
  check("(3) unknown attachmentId on a real question → 404", (await get(`/api/questions/${q1}/attachments/99`)).statusCode === 404);
  check("(3) unknown questionId (well-formed UUID) → 404", (await get(`/api/questions/00000000-0000-4000-8000-000000000000/attachments/0`)).statusCode === 404);

  // ===================== (4) realpath containment (defence in depth) =====================
  const escape = await get(`/api/questions/${q3}/attachments/0`);
  check("(4) a storedFilename escaping its own store dir → 404 (never served)", escape.statusCode === 404);
  check("(4) the escaped file's real content never reaches the response", !String(escape.rawPayload).includes("TOP SECRET"));
  // Unit-level proof of the same primitive the route calls, isolated from HTTP plumbing:
  const direct = resolveStoredAttachmentFile(q3, "../../outside-secret.txt");
  check("(4-unit) resolveStoredAttachmentFile refuses the same escaping storedFilename directly", direct.ok === false);
  const directOk = resolveStoredAttachmentFile(q1, "0-pic.png");
  check("(4-unit) POSITIVE CONTROL: a genuine in-store filename resolves ok", directOk.ok === true && directOk.absPath.endsWith("0-pic.png"));

  // ===================== (10) a junction/symlink subdir INSIDE the store, pointing OUTSIDE it ==========
  const q4 = "44444444-4444-4444-8444-444444444444";
  const q4Dir = questionAttachmentDir(q4);
  fs.mkdirSync(q4Dir, { recursive: true });
  const outsideDir = path.join(TMP, "outside-dir");
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, "secret-via-link.txt"), "TOP SECRET — reached via a store-internal junction\n");
  const linkPath = path.join(q4Dir, "escape-link");
  let linked = false;
  try { fs.symlinkSync(outsideDir, linkPath, "junction"); linked = true; }
  catch { try { fs.symlinkSync(outsideDir, linkPath, "dir"); linked = true; } catch { /* no privilege to create one — skip gracefully */ } }
  if (linked) {
    db.insertQuestion(baseQuestion(q4), [
      { id: "0", label: "ViaLink.txt", kind: "other", sizeBytes: 5, imageDimensions: null, storedFilename: "escape-link/secret-via-link.txt", originalPath: "C:\\secret\\escape.txt", openedAt: null },
    ]);
    const viaLink = await get(`/api/questions/${q4}/attachments/0`);
    check("(10) a storedFilename reached THROUGH a store-internal junction pointing outside → 404 (never served)", viaLink.statusCode === 404);
    check("(10) the linked-to content never reaches the response", !String(viaLink.rawPayload).includes("TOP SECRET"));
  } else {
    console.log("SKIP  (10) junction-escape case — could not create a junction/symlink without elevation");
  }

  // ===================== (5) Content-Disposition header-injection hardening =====================
  const injected = attachmentContentDisposition('evil"; \r\nX-Injected: yes.svg');
  check("(5) no raw CR in the emitted header value", !injected.includes("\r"));
  check("(5) no raw LF in the emitted header value", !injected.includes("\n"));
  check("(5) carries an RFC 5987 filename* extended form", injected.includes("filename*=UTF-8''"));
  check("(5) carries an ASCII filename= fallback", /filename="[^"]*"/.test(injected));
  // Non-ASCII label round-trips through the RFC 5987 form losslessly.
  const unicodeHeader = attachmentContentDisposition("モックアップ.html");
  check("(5) non-ASCII label encodes via filename* (percent-encoded UTF-8 bytes)", unicodeHeader.includes("filename*=UTF-8''%E3%83%A2"));
  // The HTTP-level header on attachment #2 (whose label itself contains the injection attempt) must also
  // be a single clean header line — Fastify would throw constructing the response if it weren't.
  check("(5-e2e) attachment #2's real Content-Disposition header has no embedded CR/LF", !String(other.headers["content-disposition"]).includes("\r") && !String(other.headers["content-disposition"]).includes("\n"));

  // ===================== (6) openedAt: first-open-wins, atomic =====================
  const beforeOpen = await get(`/api/questions/${q1}`);
  check("(6) before any open, openedAt is null", beforeOpen.json().attachments.find((a) => a.id === "0").openedAt === null);
  const open1 = await post(`/api/questions/${q1}/attachments/0/opened`);
  check("(6) first open → 200", open1.statusCode === 200);
  const stamp1 = open1.json().openedAt;
  check("(6) first open returns a real ISO timestamp", typeof stamp1 === "string" && !Number.isNaN(Date.parse(stamp1)));
  const open2 = await post(`/api/questions/${q1}/attachments/0/opened`);
  check("(6) second open → 200 (no-op, not a refusal)", open2.statusCode === 200);
  check("(6) second open returns the SAME stamp, unchanged (first-open-wins)", open2.json().openedAt === stamp1);
  // Deterministic proof of the same guarantee, with NO timing dependency at all (no fixed wait — a real-
  // clock-based "would differ if re-taken" check can't discriminate in one trial): call the DB write
  // directly with an EXPLICITLY different candidate timestamp and confirm it's still refused. This
  // discriminates correctly regardless of how fast the two HTTP calls above actually ran.
  const direct2 = db.markQuestionAttachmentOpened(q1, "0", "1999-01-01T00:00:00.000Z");
  check("(6-unit) a repeat call with an explicitly DIFFERENT candidate timestamp still returns the ORIGINAL stamp (deterministic)", direct2?.openedAt === stamp1);
  const afterOpen = await get(`/api/questions/${q1}`);
  check("(6) the read surface reflects the stamp", afterOpen.json().attachments.find((a) => a.id === "0").openedAt === stamp1);
  check("(6) opening an unknown attachment id → 404", (await post(`/api/questions/${q1}/attachments/99/opened`)).statusCode === 404);

  // ===================== (7) loopback-secret bearer guard sweeps the POST route automatically ========
  const SECRET = "test-secret-0123456789abcdef";
  const appGuarded = await buildApp({ db, extra: { loopbackSecret: SECRET } });
  const openNoAuth = await appGuarded.inject({ method: "POST", url: `/api/questions/${q1}/attachments/1/opened`, headers: H, payload: {} });
  check("(7) POST .../opened with NO Authorization header → 401", openNoAuth.statusCode === 401);
  const openWrongAuth = await appGuarded.inject({ method: "POST", url: `/api/questions/${q1}/attachments/1/opened`, headers: authH("wrong-secret"), payload: {} });
  check("(7) POST .../opened with a WRONG bearer value → 401", openWrongAuth.statusCode === 401);
  const openRightAuth = await appGuarded.inject({ method: "POST", url: `/api/questions/${q1}/attachments/1/opened`, headers: authH(SECRET), payload: {} });
  check("(7) POSITIVE CONTROL: the correct bearer secret reaches the real handler (200, not 401)", openRightAuth.statusCode === 200);
  // The sibling GET route stays unaffected — same scope as every other Tier-1 read (decision 214caa53).
  const getNoAuthGuarded = await appGuarded.inject({ method: "GET", url: `/api/questions/${q1}/attachments/0`, headers: H });
  check("(7) GET .../attachments/:id with NO auth header still succeeds (guard is write-only by design)", getNoAuthGuarded.statusCode === 200);
  await appGuarded.close();

  // ===================== (8) Origin/CORS verification, specific to these two new routes ==============
  // (8a) a PRESENT `Origin: null` (a sandboxed-iframe `"cors"`-mode fetch, or any non-GET) IS refused —
  // the pre-existing CSRF hook, not anything this card added.
  const NULL_ORIGIN_H = { ...H, origin: "null" };
  const getNullOrigin = await app.inject({ method: "GET", url: `/api/questions/${q1}/attachments/0`, headers: NULL_ORIGIN_H });
  check("(8a) GET .../attachments/:id with Origin: null (cors-mode sandboxed-iframe shape) → 403 (the pre-existing CSRF hook, not this card's own code)", getNullOrigin.statusCode === 403);
  const postNullOrigin = await app.inject({ method: "POST", url: `/api/questions/${q1}/attachments/1/opened`, headers: NULL_ORIGIN_H, payload: {} });
  check("(8a) POST .../opened with Origin: null → 403 (same hook)", postNullOrigin.statusCode === 403);
  // (8b) the CORRECTED claim (Code Review round 1): a request with NO Origin header at all (the shape of
  // a no-cors GET/HEAD subresource load — <img>, <script src>, fetch mode:'no-cors') is NOT refused by
  // this hook — it reaches the real handler. It is merely UNREADABLE by the sandboxed page, because leg
  // (8c) below proves no response ever carries a CORS grant.
  const NO_ORIGIN_H = { host: H.host, "content-type": "application/json" }; // deliberately omits origin
  const getNoOrigin = await app.inject({ method: "GET", url: `/api/questions/${q1}/attachments/0`, headers: NO_ORIGIN_H });
  check("(8b) GET .../attachments/:id with NO Origin header at all (no-cors subresource shape) → 200, reaches the real handler (NOT refused)", getNoOrigin.statusCode === 200);
  // (8c) and regardless, no response from either new route ever carries a CORS grant that would let the
  // page read it even if it reached the handler.
  check("(8c) no response from either new route ever carries Access-Control-Allow-Origin",
    img.headers["access-control-allow-origin"] === undefined && html.headers["access-control-allow-origin"] === undefined
    && open1.headers["access-control-allow-origin"] === undefined && getNoOrigin.headers["access-control-allow-origin"] === undefined);

  // ===================== (9) routeTier: both new routes (+ GET's HEAD sibling) are Tier-1 =============
  check("(9) GET /api/questions/:id/attachments/:attachmentId is Tier-1", routeTier("GET", "/api/questions/:id/attachments/:attachmentId") === 1);
  check("(9) HEAD /api/questions/:id/attachments/:attachmentId is Tier-1 (mirrors vault/raw's HEAD entry)", routeTier("HEAD", "/api/questions/:id/attachments/:attachmentId") === 1);
  check("(9) POST /api/questions/:id/attachments/:attachmentId/opened is Tier-1", routeTier("POST", "/api/questions/:id/attachments/:attachmentId/opened") === 1);

  // ===================== HEAD sibling: same headers as GET, no body =====================
  const headImg = await app.inject({ method: "HEAD", url: `/api/questions/${q1}/attachments/0`, headers: H });
  check("(HEAD) 200", headImg.statusCode === 200);
  check("(HEAD) same Content-Type as the GET", headImg.headers["content-type"] === img.headers["content-type"]);
  check("(HEAD) same Content-Security-Policy as the GET", headImg.headers["content-security-policy"] === img.headers["content-security-policy"]);
  check("(HEAD) carries Content-Length matching the real file size", Number(headImg.headers["content-length"]) === PNG_BYTES.length);
  check("(HEAD) no body", headImg.rawPayload.length === 0);
  const headMissing = await app.inject({ method: "HEAD", url: `/api/questions/${q2}/attachments/0`, headers: H });
  check("(HEAD) missing store file → 404, same as GET", headMissing.statusCode === 404);
} finally {
  try { await app.close(); } catch { /* ignore */ }
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the inbox attachment route serves image/html/other with the right per-kind headers (EVERY response now carries a sandbox CSP, derived from the SERVED content type via isActiveDocumentContentType, never from record.kind — proven against a tampered kind/extension mismatch), validates ids before any DB/fs access on both GET and POST, 404s a missing/escaping/junction-reached store file (containment proven at HTTP level, directly against resolveStoredAttachmentFile, and via a real junction), hardens Content-Disposition against header injection, stamps openedAt first-open-wins atomically, is swept into the loopback-secret guard on POST, is unaffected by GET's write-only scope, correctly distinguishes a refused cors-mode/Origin:null request from an unreadable-but-reachable no-cors request (no CORS grant exists anywhere), has a HEAD sibling mirroring GET's headers, and is Tier-1 like its sibling Requests routes."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
