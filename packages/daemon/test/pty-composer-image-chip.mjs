// Claude-free regression guard for card d9af5472 — "the terminal image-paste key counts as a dirty
// composer draft" (pty/host.ts). See docs/decisions/d9af5472-image-paste-key-counts-as-a-dirty-composer-draft.md.
//
// THE BUG (observed live): the owner's Alt+V put `[Image #N]` chips in the raw-terminal composer, but
// `nextComposerLen` read ESC v / 0x16 as zero-length, so the draft counted as CLEAN and a queued
// programmatic turn was submitted on top of the unsent images.
//
// Exercises the real PtyHost against a FAKE pty (createPty seam) — no real claude, no daemon, no network.
// The OS-dependent key goes through the injectable `imagePasteKey()` seam so BOTH branches run on one host.
// Run: node test/pty-composer-image-chip.mjs (after a build).
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-imgchip-"));
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_HUMAN_SUBMIT_CONFIRM_HOLD_MS = "60000"; // never the backstop here

const hostMod = await import("../dist/pty/host.js");
const { PtyHost, nextComposerLen, nextRawDraftState } = hostMod;
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const ALT_V = "\x1bv";
const CTRL_V = "\x16";

// ===================== PART A — pure classifiers =====================
check("imagePasteKeyForPlatform(win32) = ESC v", hostMod.imagePasteKeyForPlatform?.("win32") === ALT_V);
check("imagePasteKeyForPlatform(linux) = 0x16", hostMod.imagePasteKeyForPlatform?.("linux") === CTRL_V);
check("imagePasteKeyForPlatform(darwin) = 0x16", hostMod.imagePasteKeyForPlatform?.("darwin") === CTRL_V);

check("A1 ESC v counts as ONE unit when it is the image key (0→1)", nextComposerLen(0, ALT_V, ALT_V) === 1);
check("A2 0x16 counts as ONE unit when it is the image key (0→1)", nextComposerLen(0, CTRL_V, CTRL_V) === 1);
check("A3 two chips accumulate (0→2)", nextComposerLen(0, ALT_V + ALT_V, ALT_V) === 2);
check("A4 text + chip in one chunk (0→3)", nextComposerLen(0, "ab" + ALT_V, ALT_V) === 3);
check("A5 chip then backspace releases (1→0)", nextComposerLen(1, "\x7f", ALT_V) === 0);
check("A6 Enter / Ctrl-C / Ctrl-U / Esc free a chip draft",
  nextComposerLen(1, "\r", ALT_V) === 0 && nextComposerLen(1, "\x03", ALT_V) === 0
  && nextComposerLen(1, "\x15", ALT_V) === 0 && nextComposerLen(1, "\x1b", ALT_V) === 0);
check("A7 the OTHER OS's key is NOT counted (win32 key set, 0x16 sent → 0)", nextComposerLen(0, CTRL_V, ALT_V) === 0);
check("A8 the OTHER OS's key is NOT counted (0x16 key set, ESC v sent → 0)", nextComposerLen(0, ALT_V, CTRL_V) === 0);
check("A9 no imageKey (default) keeps the old behaviour: ESC v and 0x16 are zero-length",
  nextComposerLen(0, ALT_V) === 0 && nextComposerLen(0, CTRL_V) === 0);
check("A10 arrow keys unchanged with a chip key set (3→3)", nextComposerLen(3, "\x1b[D", ALT_V) === 3);
check("A11 a 0x16 INSIDE a bracketed paste is paste content, not a chip",
  nextComposerLen(0, "\x1b[200~a\x16b\x1b[201~", CTRL_V) === 2);

const r1 = nextRawDraftState("", ALT_V, ALT_V, 0);
check("B1 raw draft: a chip bumps `images`, never `text`", r1.images === 1 && r1.text === "" && r1.submitted === null && r1.imageSubmit === false);
const r2 = nextRawDraftState("", "\r", ALT_V, 1);
check("B2 raw draft: Enter on a chip-only draft reports imageSubmit (submitted stays null — no text)", r2.imageSubmit === true && r2.submitted === null && r2.images === 0);
const r3 = nextRawDraftState("hi", ALT_V + "\r", ALT_V, 0);
check("B3 raw draft: text + chip then Enter reports the TEXT as submitted, UNCHANGED, imageSubmit false", r3.submitted === "hi" && r3.imageSubmit === false);
const r4 = nextRawDraftState("", "\x03", ALT_V, 1);
check("B4 raw draft: Ctrl-C on a chip-only draft is a clear, not a submit", r4.imageSubmit === false && r4.images === 0);
check("B5 raw draft: Enter on an EMPTY draft is not an image submit", nextRawDraftState("", "\r", ALT_V, 0).imageSubmit === false);
check("B6 raw draft: backspace drops a chip when there is no text", nextRawDraftState("", "\x7f", ALT_V, 1).images === 0);

// ===================== PART C — the live state machine, both OS branches =====================
const fakes = [];
let imageKey = ALT_V;
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
  imagePasteKey() { return imageKey; }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
function freshSession(id) {
  host.spawn({ sessionId: id, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(id, { hook_event_name: "SessionStart" });
  return fakes[fakes.length - 1];
}
const REPORT = "WORKER_REPORT_BODY";

try {
  for (const [os_, key] of [["win32 (ESC v)", ALT_V], ["non-win32 (0x16)", CTRL_V]]) {
    imageKey = key;
    const tag = os_.split(" ")[0];

    // C1: chip then a queued turn → HELD; reconcile does not drain; the draft reads dirty.
    {
      const SID = `sess-chip-held-${tag}`;
      const fake = freshSession(SID);
      const written = () => fake.writes.join("");
      host.writeStdin(SID, key);
      check(`C1 [${os_}] a chip-only draft reads as DIRTY`, host.isComposerDirty(SID) === true);
      const r = host.enqueueStdin(SID, REPORT);
      check(`C1 [${os_}] a queued turn is HELD behind the chip (not delivered)`, r.delivered === false && r.position === 1);
      check(`C1 [${os_}] REPORT is NOT written to the pty`, !written().includes(REPORT));
      host.reconcile();
      check(`C1 [${os_}] reconcile does NOT drain onto the chip`, !written().includes(REPORT) && host.getPending(SID).length === 1);
      host.stop(SID, "hard");
    }

    // C2: Ctrl-C CLEARS the chip draft → prompt drain (same as a typed draft's clear).
    {
      const SID = `sess-chip-clear-${tag}`;
      const fake = freshSession(SID);
      const written = () => fake.writes.join("");
      host.writeStdin(SID, key);
      host.enqueueStdin(SID, REPORT);
      host.writeStdin(SID, "\x03");
      check(`C2 [${os_}] Ctrl-C clears the chip draft and the held turn drains`, host.isComposerDirty(SID) === false && written().includes(REPORT));
      host.stop(SID, "hard");
    }

    // C3: THE 2521bf51 RACE — chip, Enter, queued turn: held until the engine's UserPromptSubmit.
    {
      const SID = `sess-chip-enter-${tag}`;
      const fake = freshSession(SID);
      const written = () => fake.writes.join("");
      host.writeStdin(SID, key);
      host.enqueueStdin(SID, REPORT);
      host.writeStdin(SID, "\r");
      const lv = host.live.get(SID);
      check(`C3 [${os_}] an image-only Enter captures NO text (lastRawSubmit / pendingRawOwnerSubmit untouched)`,
        lv.lastRawSubmit == null && lv.pendingRawOwnerSubmit == null);
      check(`C3 [${os_}] ...but it DID arm the human-submit hold`, lv.humanSubmitHeldUntil > Date.now());
      check(`C3 [${os_}] Enter on a chip-only draft does NOT drain the queue before the engine confirms (2521bf51)`,
        !written().includes(REPORT) && host.getPending(SID).length === 1);
      host.reconcile();
      check(`C3 [${os_}] an unconfirmed reconcile tick does not drain it either`, !written().includes(REPORT) && host.getPending(SID).length === 1);
      host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "" });
      host.deliverHook(SID, { hook_event_name: "Stop" });
      check(`C3 [${os_}] after the engine confirms the human's turn, the held turn delivers`, written().includes(REPORT));
      host.stop(SID, "hard");
    }

    // C4: text typed, chip pasted, text backspaced away — still dirty (the chip remains).
    {
      const SID = `sess-chip-text-${tag}`;
      freshSession(SID);
      host.writeStdin(SID, "ab");
      host.writeStdin(SID, key);
      host.writeStdin(SID, "\x7f\x7f");
      check(`C4 [${os_}] text backspaced away but the chip remains → still dirty`, host.isComposerDirty(SID) === true);
      host.writeStdin(SID, "\x7f");
      check(`C4 [${os_}] one more backspace removes the chip → clean`, host.isComposerDirty(SID) === false);
      host.stop(SID, "hard");
    }

    // C6: a LONE Esc clears a chip draft and the held turn drains promptly.
    {
      const SID = `sess-chip-esc-${tag}`;
      const fake = freshSession(SID);
      host.writeStdin(SID, key);
      host.enqueueStdin(SID, REPORT);
      check(`C6 [${os_}] held behind the chip before the Esc`, host.getPending(SID).length === 1);
      host.writeStdin(SID, "\x1b");
      check(`C6 [${os_}] a lone Esc clears the chip draft and the held turn drains`,
        host.isComposerDirty(SID) === false && fake.writes.join("").includes(REPORT));
      host.stop(SID, "hard");
    }

    // C5: the OTHER OS's key is inert on this host (no over-hold).
    {
      const SID = `sess-chip-other-${tag}`;
      freshSession(SID);
      host.writeStdin(SID, key === ALT_V ? CTRL_V : ALT_V);
      check(`C5 [${os_}] the other OS's key leaves the composer CLEAN`, host.isComposerDirty(SID) === false);
      host.stop(SID, "hard");
    }
  }
} catch (e) {
  console.log("FAIL  unexpected exception", e);
  failures++;
}

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
