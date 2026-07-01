// Loom Companion — end-to-end chat loop over the Phase-1 ChatGateway (migrated from the Phase-0 spike).
// NO live Telegram, NO real claude, NO external daemon: it drives the platform-agnostic ChatGateway with a
// FAKE submit-turn spy + a FAKE channel adapter, and round-trips the chat_reply MCP tool over an IN-MEMORY
// MCP client/server pair. Asserts the two directions of the loop:
//   INBOUND  — a normalized inbound message is submitted as a turn to the RIGHT companion session (submit
//              spy), and a NON-allowlisted chat id is rejected + never submitted.
//   OUTBOUND — a chat_reply(text) is routed back to the CORRECT chat id via the bound adapter.
// Plus: config is read from env (default OFF), and chat_reply is registered ONLY for the bound companion
// session (every other manager/worker MCP surface stays byte-identical — no stray tool).
// (Exhaustive gateway conformance — chunking, dead-session ack, transport-failure — lives in
//  companion-gateway.mjs; Telegram normalization + reconnect wiring in companion-telegram.mjs.)
// Run: node test/companion-loop.mjs
import { ChatGateway } from "../dist/companion/chat-gateway.js";
import { readCompanionConfig } from "../dist/companion/config.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const CFG = { botToken: "test-token", allowedChatId: "12345", sessionId: "companion-sess" };
const CHANNEL = "telegram";
const inbound = (chatId, body) => ({ channel: CHANNEL, chatId, body });

// A minimal fake ChannelAdapter that records outbound sends (no live network).
function fakeAdapter(name, sent) {
  return { name, maxMessageLength: 4096, start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); } };
}

// --- Part A: the ChatGateway loop (fake submit + fake adapter) -----------------------------------
{
  const submitted = [];
  const submitTurn = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
  const sent = [];
  const gw = new ChatGateway(submitTurn, [{ sessionId: CFG.sessionId, channel: CHANNEL, chatId: CFG.allowedChatId }]);
  gw.registerAdapter(fakeAdapter(CHANNEL, sent));

  // INBOUND, allowlisted → submitted as a turn to the bound companion session.
  const r1 = await gw.handleInbound(inbound("12345", "hello companion"));
  check("inbound (allowlisted): accepted", r1.accepted === true);
  check("inbound: submitted exactly once", submitted.length === 1);
  check("inbound: submitted to the RIGHT companion session id", submitted[0]?.sid === "companion-sess");
  check("inbound: the message BODY is what was submitted", submitted[0]?.text === "hello companion");

  // INBOUND, FOREIGN chat id → rejected, NEVER submitted (the load-bearing allowlist).
  const r2 = await gw.handleInbound(inbound("99999", "let me in"));
  check("inbound (foreign chat id): rejected", r2.accepted === false && r2.reason === "chat-not-allowlisted");
  check("inbound (foreign chat id): NOT submitted (still exactly one submit total)", submitted.length === 1);

  // INBOUND, no text → ignored.
  const r3 = await gw.handleInbound(inbound("12345", ""));
  check("inbound (no text): rejected as no-text", r3.accepted === false && r3.reason === "no-text");
  check("inbound (no text): NOT submitted", submitted.length === 1);

  // OUTBOUND: chat_reply → delivered to the CORRECT chat id via the bound adapter, NOT re-submitted.
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

// --- Part B: readCompanionConfig from env (default OFF) -----------------------------------------
{
  check("config: no bot token → null (OFF by default)", readCompanionConfig({}) === null);
  check("config: token set but no chat id / session → null", readCompanionConfig({ LOOM_COMPANION_BOT_TOKEN: "t" }) === null);
  const cfg = readCompanionConfig({ LOOM_COMPANION_BOT_TOKEN: "t", LOOM_COMPANION_CHAT_ID: "555", LOOM_COMPANION_SESSION_ID: "sess-1" });
  check("config: all three set → config with token FROM ENV", cfg?.botToken === "t" && cfg?.allowedChatId === "555" && cfg?.sessionId === "sess-1");
  const trimmed = readCompanionConfig({ LOOM_COMPANION_BOT_TOKEN: "  t  ", LOOM_COMPANION_CHAT_ID: " 9 ", LOOM_COMPANION_SESSION_ID: " s " });
  check("config: values are trimmed", trimmed?.botToken === "t" && trimmed?.allowedChatId === "9" && trimmed?.sessionId === "s");
}

// --- Part C: chat_reply MCP tool — registered ONLY for the bound companion session --------------
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
  const deliverReply = async (sid, text) => { delivered.push({ sid, text }); return { delivered: true, chunks: 1 }; };
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
