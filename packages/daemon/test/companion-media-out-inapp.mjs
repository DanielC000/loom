import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — `media-out`'s IN-APP delivery (card 9ec79b52, fast-follow to the Telegram-first v1
// send_media lever). Fully hermetic: a real ChatGateway + the real InAppChannel + a fake web client (the
// InAppClient seam) + a real temp file on disk — NO real browser, NO network, NO daemon. Mirrors
// companion-voice-web-outbound.mjs's structure (the sendVoice equivalent for outbound media).
//
// Proves:
//   1. InAppChannel.adapter.sendMedia: reads + base64-encodes the file and pushes a { type:"media" } frame
//      to every attached web client, with the correct mimeType (by extension) and fileName.
//   2. NO chat-history record for a media delivery (mirrors ChatGateway.deliverMedia's own doc — media isn't
//      part of the companion_messages.text conversation log) and NO push at all with zero attached clients
//      (no store-and-forward for media, unlike a text reply).
//   3. An oversize file (over IN_APP_MEDIA_MAX_BYTES) THROWS — never read/encoded — so ChatGateway.deliverMedia
//      reports {delivered:false, reason:"send-failed"} instead of silently truncating or OOMing a client.
//   4. End-to-end ChatGateway.deliverMedia: resolves the target from the active turn's origin (exactly like
//      deliverReply) and delivers through the in-app adapter — closing the gap where in-app used to degrade
//      to {delivered:false, reason:"unsupported-channel"}.
//   5. A non-image extension (e.g. .pdf) resolves a non-"image/*" mimeType, so the web panel renders it as an
//      attachment card instead of inlining it — the client-side rendering split is driven by this field.
// Run: 1) build (turbo builds shared first), 2) node test/companion-media-out-inapp.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatGateway } from "../dist/companion/chat-gateway.js";
import { InAppChannel, IN_APP_CHANNEL, IN_APP_MEDIA_MAX_BYTES } from "../dist/companion/in-app.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const makeClient = () => { const frames = []; return { frames, client: { deliver: (f) => frames.push(f) } }; };
const inAppBinding = (sessionId) => ({ sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, scope: "dm" });

try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-media-inapp-"));

  // ================= 1 — sendMedia pushes a { type:"media" } frame with the right shape =================
  {
    const filePath = path.join(dir, "mockup.png");
    const bytes = Buffer.from("fake png bytes");
    fs.writeFileSync(filePath, bytes);

    const inApp = new InAppChannel();
    const { frames, client } = makeClient();
    inApp.attach("sess-A", client);

    await inApp.adapter.sendMedia("sess-A", filePath, { fileName: "mockup.png" });
    check("1: sendMedia delivered exactly one media frame", frames.length === 1 && frames[0].type === "media");
    check("1: the frame carries the correct chatId + fileName + mimeType", frames[0].chatId === "sess-A" && frames[0].fileName === "mockup.png" && frames[0].mimeType === "image/png");
    check("1: the frame's base64 data decodes to the exact source bytes", Buffer.from(frames[0].data, "base64").equals(bytes));
  }

  // ================= 1b — fileName defaults to the basename when opts.fileName is omitted ================
  {
    const filePath = path.join(dir, "shot.jpg");
    fs.writeFileSync(filePath, "jpeg-ish bytes");
    const inApp = new InAppChannel();
    const { frames, client } = makeClient();
    inApp.attach("sess-B", client);
    await inApp.adapter.sendMedia("sess-B", filePath);
    check("1b: fileName defaults to path.basename(filePath)", frames[0].fileName === "shot.jpg");
    check("1b: mimeType resolved from the .jpg extension", frames[0].mimeType === "image/jpeg");
  }

  // ================= 2 — NO chat-history record; NO push with zero attached clients ======================
  {
    const filePath = path.join(dir, "no-history.png");
    fs.writeFileSync(filePath, "bytes");
    const recorded = [];
    const inApp = new InAppChannel({ record: (sid, author, text) => recorded.push({ sid, author, text }) });

    // No client attached at all — sendMedia must not throw, and (unlike a text reply) there is no
    // store-and-forward: the push is simply dropped, nothing durable is written.
    let threw = false;
    try { await inApp.adapter.sendMedia("sess-C", filePath); } catch { threw = true; }
    check("2: sendMedia with no attached client does not throw", threw === false);
    check("2: a media delivery is NEVER recorded to chat history", recorded.length === 0);

    // Attach a client and try again — still no history record, even though the push now lands live.
    const { frames, client } = makeClient();
    inApp.attach("sess-C", client);
    await inApp.adapter.sendMedia("sess-C", filePath);
    check("2b: with a client attached, the frame is pushed live", frames.length === 1 && frames[0].type === "media");
    check("2b: still no chat-history record for the delivered media", recorded.length === 0);
  }

  // ================= 3 — an oversize file THROWS, never read/encoded =====================================
  {
    const filePath = path.join(dir, "huge.bin");
    // Sparse-write past the cap without actually allocating IN_APP_MEDIA_MAX_BYTES of real bytes on disk.
    const fd = fs.openSync(filePath, "w");
    fs.writeSync(fd, Buffer.from("x"), 0, 1, IN_APP_MEDIA_MAX_BYTES + 1);
    fs.closeSync(fd);

    const inApp = new InAppChannel();
    const { frames, client } = makeClient();
    inApp.attach("sess-D", client);

    let threw = false;
    try { await inApp.adapter.sendMedia("sess-D", filePath); } catch { threw = true; }
    check("3: an oversize file makes sendMedia throw", threw === true);
    check("3: nothing was pushed to the attached client", frames.length === 0);
  }

  // ================= 4 — end-to-end ChatGateway.deliverMedia reaches the in-app adapter ===================
  {
    const filePath = path.join(dir, "reply-mockup.png");
    const bytes = Buffer.from("mockup png bytes for e2e");
    fs.writeFileSync(filePath, bytes);

    const inApp = new InAppChannel();
    // deliverMedia resolves the target from the active turn's own origin (mirrors deliverReply) — sess-A's
    // turn came in on in-app/sess-A, so the file goes to that in-app chat.
    const gw = new ChatGateway(() => ({ delivered: true }), [inAppBinding("sess-A")], undefined, undefined, (sid) => (sid === "sess-A" ? { channel: IN_APP_CHANNEL, chatId: "sess-A" } : null));
    gw.registerAdapter(inApp.adapter);

    const { frames, client } = makeClient();
    inApp.attach("sess-A", client);

    const result = await gw.deliverMedia("sess-A", filePath);
    check("4: deliverMedia reports delivered:true (in-app now supports media — no more unsupported-channel)", result.delivered === true && result.reason === undefined);
    check("4: the web client received exactly one media frame with the correct bytes", frames.length === 1 && frames[0].type === "media" && Buffer.from(frames[0].data, "base64").equals(bytes));
  }

  // ================= 5 — a non-image file resolves a non-image mimeType (attachment-card path) ============
  {
    const filePath = path.join(dir, "report.pdf");
    fs.writeFileSync(filePath, "%PDF-1.4 fake pdf bytes");
    const inApp = new InAppChannel();
    const { frames, client } = makeClient();
    inApp.attach("sess-E", client);
    await inApp.adapter.sendMedia("sess-E", filePath);
    check("5: a .pdf resolves mimeType application/pdf (not image/*)", frames[0].mimeType === "application/pdf");
    check("5: mimeType does not start with image/ — the panel renders this as an attachment card", !frames[0].mimeType.startsWith("image/"));
  }

  fs.rmSync(dir, { recursive: true, force: true });
} catch (err) {
  console.error(err);
  failures++;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the in-app channel now DELIVERS media (card 9ec79b52): sendMedia base64-inlines a file into a { type:'media' } WS frame (correct mimeType-by-extension + fileName), never records it to chat history and never store-and-forwards with zero attached clients, throws (never silently truncates) over the size cap, and ChatGateway.deliverMedia reaches it end-to-end exactly like deliverReply's own target resolution."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
