// Loom Companion — Phase 0 spike hermetic test (card: prove the end-to-end chat loop). NO live
// Telegram, NO real claude, NO external daemon: it drives the transport-agnostic CompanionGateway core
// with a FAKE submit-turn spy + a FAKE transport, and round-trips the chat_reply MCP tool over an
// IN-MEMORY MCP client/server pair. Asserts the two directions of the loop:
//   INBOUND  — an inbound update is submitted as a turn to the RIGHT companion session (submit spy),
//              and a NON-allowlisted chat id is rejected + never submitted.
//   OUTBOUND — a chat_reply(text) is routed back to the CORRECT chat id via the injected fake transport.
// Plus: config is read from env (default OFF), and chat_reply is registered ONLY for the bound companion
// session (every other manager/worker MCP surface stays byte-identical — no stray tool).
// Run: node test/companion-loop.mjs
import { CompanionGateway, normalizeTelegramUpdate, readCompanionConfig } from "../dist/companion/gateway.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const CFG = { botToken: "test-token", allowedChatId: "12345", sessionId: "companion-sess" };

// --- Part A: the CompanionGateway loop (fake submit + fake transport) ---------------------------
{
  const submitted = [];
  const submitTurn = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
  const sent = [];
  const transport = { async send(chatId, text) { sent.push({ chatId, text }); } };
  const gw = new CompanionGateway(CFG, submitTurn, transport);

  // INBOUND, allowlisted → submitted as a turn to the bound companion session.
  const r1 = gw.handleInboundUpdate({ message: { chat: { id: 12345 }, text: "hello companion" } });
  check("inbound (allowlisted): accepted", r1.accepted === true);
  check("inbound: submitted exactly once", submitted.length === 1);
  check("inbound: submitted to the RIGHT companion session id", submitted[0]?.sid === "companion-sess");
  check("inbound: the message TEXT is what was submitted", submitted[0]?.text === "hello companion");

  // INBOUND, FOREIGN chat id → rejected, NEVER submitted (the load-bearing allowlist).
  const r2 = gw.handleInboundUpdate({ message: { chat: { id: 99999 }, text: "let me in" } });
  check("inbound (foreign chat id): rejected", r2.accepted === false && r2.reason === "chat-not-allowlisted");
  check("inbound (foreign chat id): NOT submitted (still exactly one submit total)", submitted.length === 1);

  // INBOUND, no text (e.g. a photo/sticker update) → ignored.
  const r3 = gw.handleInboundUpdate({ message: { chat: { id: 12345 } } });
  check("inbound (no text): rejected as no-text", r3.accepted === false && r3.reason === "no-text");
  check("inbound (no text): NOT submitted", submitted.length === 1);

  // OUTBOUND: chat_reply → delivered to the CORRECT chat id via the fake transport, NOT re-submitted.
  const d1 = await gw.deliverReply("companion-sess", "here is your answer");
  check("outbound: delivered", d1.delivered === true);
  check("outbound: sent exactly once", sent.length === 1);
  check("outbound: routed to the CORRECT chat id", sent[0]?.chatId === "12345");
  check("outbound: the reply text is delivered verbatim", sent[0]?.text === "here is your answer");
  check("outbound: deliverReply did NOT loop back as a turn (submit count unchanged)", submitted.length === 1);

  // OUTBOUND from an UNKNOWN session → rejected, nothing sent.
  const d2 = await gw.deliverReply("some-other-session", "leak?");
  check("outbound (unknown session): rejected", d2.delivered === false && d2.reason === "unknown-session");
  check("outbound (unknown session): nothing sent", sent.length === 1);
}

// --- Part B: normalizeTelegramUpdate edge cases -------------------------------------------------
{
  check("normalize: numeric chat id is stringified", normalizeTelegramUpdate({ message: { chat: { id: 42 }, text: "x" } })?.chatId === "42");
  check("normalize: no message → null", normalizeTelegramUpdate({}) === null);
  check("normalize: empty text → null", normalizeTelegramUpdate({ message: { chat: { id: 1 }, text: "" } }) === null);
  check("normalize: missing chat → null", normalizeTelegramUpdate({ message: { text: "x" } }) === null);
  check("normalize: null update → null", normalizeTelegramUpdate(null) === null);
}

// --- Part C: readCompanionConfig from env (default OFF) -----------------------------------------
{
  check("config: no bot token → null (OFF by default)", readCompanionConfig({}) === null);
  check("config: token set but no chat id / session → null", readCompanionConfig({ LOOM_COMPANION_BOT_TOKEN: "t" }) === null);
  const cfg = readCompanionConfig({ LOOM_COMPANION_BOT_TOKEN: "t", LOOM_COMPANION_CHAT_ID: "555", LOOM_COMPANION_SESSION_ID: "sess-1" });
  check("config: all three set → config with token FROM ENV", cfg?.botToken === "t" && cfg?.allowedChatId === "555" && cfg?.sessionId === "sess-1");
  const trimmed = readCompanionConfig({ LOOM_COMPANION_BOT_TOKEN: "  t  ", LOOM_COMPANION_CHAT_ID: " 9 ", LOOM_COMPANION_SESSION_ID: " s " });
  check("config: values are trimmed", trimmed?.botToken === "t" && trimmed?.allowedChatId === "9" && trimmed?.sessionId === "s");
}

// --- Part D: chat_reply MCP tool — registered ONLY for the bound companion session --------------
// Round-trip the router's MCP server over an in-memory client/server pair. Stub db/sessions ({}): the
// tool handlers are never invoked except chat_reply, which touches only the injected deliverReply.
async function toolsFor(router, sessionId, role) {
  const server = router.buildServer(sessionId, role); // TS-private, but a plain method at runtime
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  const { tools } = await client.listTools();
  return { client, names: tools.map((t) => t.name), close: async () => { await client.close(); await server.close(); } };
}

{
  const delivered = [];
  const deliverReply = async (sid, text) => { delivered.push({ sid, text }); return { delivered: true }; };
  const router = new OrchestrationMcpRouter({}, {}, { companionSessionId: "companion-sess", deliverReply });

  // Companion session (manager role) — chat_reply present + it routes to deliverReply.
  {
    const { client, names, close } = await toolsFor(router, "companion-sess", "manager");
    check("router: companion manager session HAS chat_reply", names.includes("chat_reply"));
    const res = await client.callTool({ name: "chat_reply", arguments: { text: "routed reply" } });
    const payload = JSON.parse(res.content[0].text);
    check("router: chat_reply routes to deliverReply (delivered)", payload.delivered === true);
    check("router: deliverReply got the bound session id + text", delivered.length === 1 && delivered[0].sid === "companion-sess" && delivered[0].text === "routed reply");
    await close();
  }

  // Companion bound to a WORKER session also gets chat_reply (registered before the role split).
  {
    const { names, close } = await toolsFor(router, "companion-sess", "worker");
    check("router: companion worker session HAS chat_reply", names.includes("chat_reply"));
    await close();
  }

  // A DIFFERENT manager session must NOT see chat_reply (byte-identical surface — no stray tool).
  {
    const { names, close } = await toolsFor(router, "some-other-session", "manager");
    check("router: non-companion manager does NOT have chat_reply", !names.includes("chat_reply"));
    check("router: non-companion manager still has its normal surface (worker_spawn)", names.includes("worker_spawn"));
    await close();
  }
}

// A router with NO companion hooks never registers chat_reply anywhere (companion off).
{
  const router = new OrchestrationMcpRouter({}, {}, {});
  const { names, close } = await toolsFor(router, "any-session", "manager");
  check("router (companion off): no chat_reply on any session", !names.includes("chat_reply"));
  await close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — inbound submits a turn to the bound session (allowlist rejects foreign chat ids), chat_reply routes back to the correct chat id, and chat_reply is gated to the companion session only."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
