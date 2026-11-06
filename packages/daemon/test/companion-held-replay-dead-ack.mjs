// Card 64d2fa4b — a held inbound (parked by withCompanionSelfHeal during a recycle/upgrade, already acked
// "queued" by the gateway) whose replay finds the session STILL dead must error-ack the owner on the SAME
// channel with the SAME text a dead inbound gets today, exactly once. Hermetic: REAL ChatGateway + REAL
// withCompanionSelfHeal, a fake ChannelAdapter per channel, a manual transition seam (hold/end), a scripted
// submit. No pty/db/claude/network.
// Run: 1) build, 2) node packages/daemon/test/companion-held-replay-dead-ack.mjs
import { ChatGateway } from "../dist/companion/chat-gateway.js";
import { withCompanionSelfHeal } from "../dist/companion/revive.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeAdapter(name) {
  const sent = [];
  return { sent, adapter: { name, maxMessageLength: 4096, start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); } } };
}
const inbound = (channel, chatId, body) => ({ channel, chatId, body, chatIsDirect: true });
const DEAD_TEXT_FRAGMENT = "isn't currently running";

/** A rig: the sessions' pty is `alive` or not; a transition is "in flight" until end() runs the parked replays. */
function rig(channel, chatId) {
  const st = { alive: false, inFlight: true, parked: [], delivered: [], replayDead: [] };
  const submit = (_sid, text) => {
    if (!st.alive) return { delivered: false };
    st.delivered.push(text);
    return { delivered: true };
  };
  const healing = withCompanionSelfHeal(submit, {
    resume: () => { throw new Error("unresumable"); },
    transition: { holdIfInFlight: (_sid, replay) => (st.inFlight ? st.parked.push(replay) : null) },
    onReplayDead: (sid) => st.replayDead.push(sid),
  });
  const gw = new ChatGateway(healing, [{ sessionId: "sess-A", channel, chatId }]);
  const ch = makeAdapter(channel);
  gw.registerAdapter(ch.adapter);
  const end = () => { st.inFlight = false; for (const r of st.parked.splice(0)) r(); };
  return { st, gw, ch, end };
}

// Baseline: what a plain DEAD inbound is acked with (no transition in flight), per channel.
const baselineText = {};
for (const [channel, chatId] of [["telegram", "111"], ["in-app", "sess-A"]]) {
  const r = rig(channel, chatId);
  r.st.inFlight = false;
  const res = await r.gw.handleInbound(inbound(channel, chatId, "anyone home?"));
  baselineText[channel] = r.ch.sent[0]?.text;
  check(`${channel} baseline: a dead inbound gets the session-dead ack`, res.reason === "session-dead" && r.ch.sent.length === 1 && baselineText[channel].includes(DEAD_TEXT_FRAGMENT));
}

// Dead replay: held (acked queued), op ends, pty still dead -> ONE error ack on the right channel/chat.
for (const [channel, chatId] of [["telegram", "111"], ["in-app", "sess-A"]]) {
  const r = rig(channel, chatId);
  const res = await r.gw.handleInbound(inbound(channel, chatId, "held message"));
  check(`${channel} dead replay: the gateway acked it as queued (held) and sent no error yet`, res.accepted === true && res.queued === true && r.ch.sent.length === 0);
  r.end();
  await new Promise((resolve) => setImmediate(resolve)); // the ack send is fire-and-forget from the replay
  check(`${channel} dead replay: exactly ONE ack, on the originating chat, with the same text a dead inbound gets`,
    r.ch.sent.length === 1 && r.ch.sent[0].chatId === chatId && r.ch.sent[0].text === baselineText[channel]);
  check(`${channel} dead replay: onReplayDead's daemon-level hook still fired once`, r.st.replayDead.length === 1 && r.st.replayDead[0] === "sess-A");
}

// Success replay: op ends and the pty is alive -> delivered, NO ack at all.
for (const [channel, chatId] of [["telegram", "111"], ["in-app", "sess-A"]]) {
  const r = rig(channel, chatId);
  await r.gw.handleInbound(inbound(channel, chatId, "held message"));
  r.st.alive = true;
  r.end();
  await new Promise((resolve) => setImmediate(resolve));
  check(`${channel} success replay: delivered once, no extra ack, onReplayDead not fired`,
    r.st.delivered.length === 1 && r.ch.sent.length === 0 && r.st.replayDead.length === 0);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
