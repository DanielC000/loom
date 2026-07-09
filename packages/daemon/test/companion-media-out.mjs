import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — `media-out` (`send_media`, card 3a81b0f2): deliver
// an ALLOWLISTED file (a mockup, a vault Assets screenshot, a Playwright shot) to the owner's chat.
// Delivery was TELEGRAM-FIRST v1 (owner decision 2026-07-09); the in-app fast-follow (card 9ec79b52) closed
// the gap — the real in-app delivery is covered by companion-media-out-inapp.mjs. THIS file drives the
// lever with a FAKE `companion` (see makeFakeCompanion below), so its "unsupported-channel" case (g) below
// now models a hypothetical channel with no `sendMedia` at all, not in-app specifically.
//
// NO Primitive A/B/C here (design note, confirmed): there is no owner-composed content to attest and the
// roots aren't a project-decision — the ENTIRE security model is the path allowlist (the SAME
// lexical+realpath two-layer guard the vault reader uses, `resolveVaultFilePath`), so this test's whole
// focus is that guard + the roots union + the graceful unsupported-channel degrade, NOT a confirm round-trip.
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME + real fixture dirs (incl. a real filesystem junction for
// the symlink-escape case, mirrors test/vault-browser.mjs) + the REAL OrchestrationMcpRouter over an
// in-memory MCP transport, driven with a FAKE `companion` (deliverMedia) capturing every delivered path. NO
// network, NO real claude, NO daemon, NO real Telegram send (that's a post-deploy live check).
//
// Covers the card's DoD:
//   (a) a path inside an allowlisted root delivers — the fake outbound seam receives the resolved abs path.
//   (b) '../' traversal outside every root is rejected with an {error}; nothing is delivered.
//   (c) an absolute path outside every allowlisted root is rejected; nothing is delivered.
//   (d) a symlink/junction INSIDE a root pointing OUTSIDE it is rejected (the realpath layer, not just the
//       lexical one) — the load-bearing case.
//   (e) an unconfigured / empty roots allowlist delivers NOTHING (conservative default).
//   (f) roots union-merge across every granted project's own config row.
//   (g) delivery on a channel with no media support degrades to {status:'unsupported-channel', note} —
//       never an error — naming the resolved path.
//   (h) a genuine send failure (adapter threw / send-failed) is reported as an {error}, not swallowed.
//   (i) read-only-only grant (no act-mode project) ⇒ send_media is NOT registered (byte-identical).
//   (j) no grant at all ⇒ send_media is NOT registered.
// Run: 1) build (turbo builds shared first), 2) node test/companion-media-out.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-media-out-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-media-out-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const now = new Date().toISOString();
function seedProject(db, id, name) {
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
}
function seedSession(db, id, projectId, role) {
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role, startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projectId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role, taskId: null,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

// A FAKE companion (CompanionHooks) — the ONLY method the media-out outbound seam calls is `deliverMedia`.
// `mode` selects the simulated result: "ok" delivers, "unsupported" mirrors an adapter with no sendMedia,
// "fail" mirrors a genuine send-failed.
function makeFakeCompanion(mode = "ok") {
  const delivered = [];
  return {
    async deliverMedia(sessionId, filePath) {
      delivered.push({ sessionId, filePath });
      if (mode === "ok") return { delivered: true };
      if (mode === "unsupported") return { delivered: false, reason: "unsupported-channel" };
      return { delivered: false, reason: "send-failed" };
    },
    delivered,
  };
}

function makeRoot(nameSuffix) {
  const dir = path.join(tmpHome, `root-${nameSuffix}-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

try {
  // ============ (a) inside-root delivers via the fake outbound seam ============
  {
    const root = makeRoot("a");
    const filePath = path.join(root, "mockup.png");
    fs.writeFileSync(filePath, "fake png bytes");

    const db = tmpDb();
    const proj = "proj-media-a";
    seedProject(db, proj, "Media A");
    const companionSess = "companion-media-a";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "media-out", projectId: proj, mode: "act", config: { roots: [root] } });

    const companion = makeFakeCompanion("ok");
    const orch = new OrchestrationMcpRouter(db, {}, companion);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "send_media", { pathOrName: "mockup.png" });
    check("(a) inside-root by bare filename: status:'sent'", res.status === "sent");
    check("(a) exactly one delivery was attempted", companion.delivered.length === 1);
    check("(a) the delivered path is the resolved REAL absolute path inside the root",
      companion.delivered[0].filePath === fs.realpathSync(filePath));
    check("(a) delivered to THIS companion session", companion.delivered[0].sessionId === companionSess);

    // Also resolves when the FULL absolute in-root path is given (not just a bare filename).
    const res2 = await call(client, "send_media", { pathOrName: filePath });
    check("(a) inside-root by full absolute path: status:'sent'", res2.status === "sent");
    check("(a) two deliveries attempted now", companion.delivered.length === 2);

    await client.close();
    db.close();
  }

  // ============ (a2) CR fix: a DIRECTORY inside an allowlisted root is a clean not-a-file rejection ============
  // resolveVaultFilePath only proves containment/existence, not "regular file" — mirrors statVaultFile's
  // own isFile() check. Before the fix this would have resolved and reached the adapter (a confusing
  // send-failed instead of a clean rejection); no security issue either way (containment held), but the
  // error must be clean and the adapter must never even be asked to stream a directory.
  {
    const root = makeRoot("dir-rejection");
    fs.mkdirSync(path.join(root, "a-directory"));

    const db = tmpDb();
    const proj = "proj-media-dir";
    seedProject(db, proj, "Media Dir");
    const companionSess = "companion-media-dir";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "media-out", projectId: proj, mode: "act", config: { roots: [root] } });

    const companion = makeFakeCompanion("ok");
    const orch = new OrchestrationMcpRouter(db, {}, companion);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "send_media", { pathOrName: "a-directory" });
    check("(a2) CR FIX: a directory inside a root is a clean {error}, not a bare status", typeof res.error === "string" && res.status === undefined);
    check("(a2) the adapter's sendMedia was NEVER called for a directory", companion.delivered.length === 0);

    await client.close();
    db.close();
  }

  // ============ (b) '../' traversal outside every root is rejected ============
  {
    const root = makeRoot("traversal");
    const outside = makeRoot("traversal-outside");
    fs.writeFileSync(path.join(outside, "secret.png"), "top secret bytes");

    const db = tmpDb();
    const proj = "proj-media-traversal";
    seedProject(db, proj, "Media Traversal");
    const companionSess = "companion-media-traversal";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "media-out", projectId: proj, mode: "act", config: { roots: [root] } });

    const companion = makeFakeCompanion("ok");
    const orch = new OrchestrationMcpRouter(db, {}, companion);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const relTraversal = `..${path.sep}${path.basename(outside)}${path.sep}secret.png`;
    const res = await call(client, "send_media", { pathOrName: relTraversal });
    check("(b) '../' traversal: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("(b) nothing was delivered", companion.delivered.length === 0);

    await client.close();
    db.close();
  }

  // ============ (c) an absolute path outside every allowlisted root is rejected ============
  {
    const root = makeRoot("absout");
    const outside = makeRoot("absout-outside");
    const outsideFile = path.join(outside, "not-allowed.png");
    fs.writeFileSync(outsideFile, "top secret bytes");

    const db = tmpDb();
    const proj = "proj-media-absout";
    seedProject(db, proj, "Media Abs Outside");
    const companionSess = "companion-media-absout";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "media-out", projectId: proj, mode: "act", config: { roots: [root] } });

    const companion = makeFakeCompanion("ok");
    const orch = new OrchestrationMcpRouter(db, {}, companion);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "send_media", { pathOrName: outsideFile });
    check("(c) absolute path outside every root: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("(c) nothing was delivered", companion.delivered.length === 0);

    await client.close();
    db.close();
  }

  // ============ (d) LOAD-BEARING: a symlink/junction INSIDE a root pointing OUTSIDE it is rejected ============
  // Lexically `root/link/secret.png` looks in-bounds; only the realpath layer reveals it escapes.
  {
    const root = makeRoot("symlink");
    const outside = makeRoot("symlink-outside");
    fs.writeFileSync(path.join(outside, "secret.png"), "top secret bytes");

    const linkDir = path.join(root, "link");
    let linked = false;
    try { fs.symlinkSync(outside, linkDir, "junction"); linked = true; }
    catch { try { fs.symlinkSync(outside, linkDir, "dir"); linked = true; } catch { /* no privilege */ } }

    if (linked) {
      const db = tmpDb();
      const proj = "proj-media-symlink";
      seedProject(db, proj, "Media Symlink");
      const companionSess = "companion-media-symlink";
      seedSession(db, companionSess, proj, "assistant");
      db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "media-out", projectId: proj, mode: "act", config: { roots: [root] } });

      const companion = makeFakeCompanion("ok");
      const orch = new OrchestrationMcpRouter(db, {}, companion);
      const client = await connect(orch.buildServer(companionSess, "assistant"));

      const res = await call(client, "send_media", { pathOrName: path.join("link", "secret.png") });
      check("(d) LOAD-BEARING: an in-root symlink pointing outside is rejected (realpath layer)", typeof res.error === "string" && res.status === undefined);
      check("(d) nothing was delivered", companion.delivered.length === 0);

      await client.close();
      db.close();
    } else {
      console.log("SKIP  (d) symlink-escape case — could not create a link/junction without elevation");
    }
  }

  // ============ (e) an unconfigured / empty roots allowlist delivers NOTHING ============
  {
    const db = tmpDb();
    const proj = "proj-media-noroots";
    seedProject(db, proj, "Media No Roots");
    const companionSess = "companion-media-noroots";
    seedSession(db, companionSess, proj, "assistant");
    // act-mode grant, but NO roots configured at all.
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "media-out", projectId: proj, mode: "act" });

    const companion = makeFakeCompanion("ok");
    const orch = new OrchestrationMcpRouter(db, {}, companion);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    check("(e) send_media IS registered (act-mode grant exists, just no roots)", (await client.listTools()).tools.some((t) => t.name === "send_media"));
    const res = await call(client, "send_media", { pathOrName: "anything.png" });
    check("(e) absent roots config: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("(e) nothing was delivered", companion.delivered.length === 0);

    // Same result for an EXPLICITLY empty roots array.
    const db2 = tmpDb();
    seedProject(db2, proj, "Media Empty Roots");
    seedSession(db2, companionSess, proj, "assistant");
    db2.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "media-out", projectId: proj, mode: "act", config: { roots: [] } });
    const companion2 = makeFakeCompanion("ok");
    const orch2 = new OrchestrationMcpRouter(db2, {}, companion2);
    const client2 = await connect(orch2.buildServer(companionSess, "assistant"));
    const res2 = await call(client2, "send_media", { pathOrName: "anything.png" });
    check("(e) explicitly empty roots[]: rejected with an {error} too", typeof res2.error === "string" && res2.status === undefined);
    check("(e) nothing was delivered (empty array case)", companion2.delivered.length === 0);

    await client.close();
    await client2.close();
    db.close();
    db2.close();
  }

  // ============ (f) roots union-merge across every granted project's own config row ============
  {
    const rootOne = makeRoot("union-one");
    const rootTwo = makeRoot("union-two");
    fs.writeFileSync(path.join(rootOne, "from-one.png"), "bytes one");
    fs.writeFileSync(path.join(rootTwo, "from-two.png"), "bytes two");

    const db = tmpDb();
    const projOne = "proj-media-union-one";
    const projTwo = "proj-media-union-two";
    seedProject(db, projOne, "Union One");
    seedProject(db, projTwo, "Union Two");
    const companionSess = "companion-media-union";
    seedSession(db, companionSess, projOne, "assistant");
    // projOne is act-mode (registers the tool) with rootOne; projTwo is READ-mode (doesn't itself grant
    // act) but its own configured root STILL contributes to the union — mayAct gates TOOL REGISTRATION,
    // not which granted project's roots count (mirrors attention-push's alertClasses union, which doesn't
    // filter by mayAct either).
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "media-out", projectId: projOne, mode: "act", config: { roots: [rootOne] } });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "media-out", projectId: projTwo, mode: "read", config: { roots: [rootTwo] } });

    const companion = makeFakeCompanion("ok");
    const orch = new OrchestrationMcpRouter(db, {}, companion);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const resOne = await call(client, "send_media", { pathOrName: "from-one.png" });
    check("(f) a file in the ACT-granted project's root resolves", resOne.status === "sent");
    const resTwo = await call(client, "send_media", { pathOrName: "from-two.png" });
    check("(f) a file in the READ-granted project's root ALSO resolves (union, not intersection)", resTwo.status === "sent");
    check("(f) both deliveries went through", companion.delivered.length === 2);

    await client.close();
    db.close();
  }

  // ============ (g) unsupported-channel degrades gracefully (never an error) ============
  {
    const root = makeRoot("unsupported");
    const filePath = path.join(root, "shot.png");
    fs.writeFileSync(filePath, "bytes");

    const db = tmpDb();
    const proj = "proj-media-unsupported";
    seedProject(db, proj, "Media Unsupported");
    const companionSess = "companion-media-unsupported";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "media-out", projectId: proj, mode: "act", config: { roots: [root] } });

    const companion = makeFakeCompanion("unsupported");
    const orch = new OrchestrationMcpRouter(db, {}, companion);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "send_media", { pathOrName: "shot.png" });
    check("(g) unsupported-channel: status:'unsupported-channel', NOT an {error}", res.status === "unsupported-channel" && res.error === undefined);
    check("(g) the note names the resolved path", typeof res.note === "string" && res.note.includes(fs.realpathSync(filePath)));

    await client.close();
    db.close();
  }

  // ============ (h) a genuine send failure is reported as an {error}, not swallowed ============
  {
    const root = makeRoot("failure");
    fs.writeFileSync(path.join(root, "shot.png"), "bytes");

    const db = tmpDb();
    const proj = "proj-media-failure";
    seedProject(db, proj, "Media Failure");
    const companionSess = "companion-media-failure";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "media-out", projectId: proj, mode: "act", config: { roots: [root] } });

    const companion = makeFakeCompanion("fail");
    const orch = new OrchestrationMcpRouter(db, {}, companion);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "send_media", { pathOrName: "shot.png" });
    check("(h) a genuine send failure: rejected with an {error}, not a bare status", typeof res.error === "string" && res.status === undefined);

    await client.close();
    db.close();
  }

  // ============ (i) read-only-only grant ⇒ send_media is NOT registered ============
  {
    const db = tmpDb();
    const proj = "proj-media-readonly";
    seedProject(db, proj, "Media Read Only");
    const companionSess = "companion-media-readonly";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "media-out", projectId: proj, mode: "read", config: { roots: [makeRoot("readonly")] } });

    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("(i) a read-only-only grant does NOT register send_media", !tools.includes("send_media"));
    db.close();
  }

  // ============ (j) no grant at all ⇒ send_media is NOT registered ============
  {
    const db = tmpDb();
    const proj = "proj-media-nogrant";
    seedProject(db, proj, "Media No Grant");
    const companionSess = "companion-media-nogrant";
    seedSession(db, companionSess, proj, "assistant");

    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("(j) an ungranted companion does NOT have send_media", !tools.includes("send_media"));
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — send_media registers ONLY behind an act-mode media-out grant; a path resolving inside an allowlisted root delivers via the outbound seam, while '../' traversal, an absolute path outside every root, and (load-bearing) an in-root symlink/junction pointing outside are all rejected with an {error} and nothing is delivered; an absent/empty roots allowlist delivers nothing; roots union-merge across every granted project's own config row; a channel with no media support degrades to {status:'unsupported-channel', note} naming the resolved path rather than erroring; a genuine send failure is reported as an {error}; and a read-only-only or absent grant never registers the tool."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
