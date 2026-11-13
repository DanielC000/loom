// Card 85ecb523 — the workspace-trust dialog signature must match claude 2.1.323's wording AND the older one.
// Fed REAL recorded bytes (fixtures/85ecb523-*.json, from the Rust PTY spike's byte-exact corpus), never a synthetic string.
// Hermetic: pure detector functions only; no spawn, no daemon.
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
useOwnLoomHome("wtd-");
import fs from "node:fs";
const { collapseBoot, detectBlockingDialogSignature, detectNewestBlockingDialogSignature } = await import("../dist/pty/host.js");

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; };

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/85ecb523-real-workspace-trust-dialog-claude-2.1.323.json", import.meta.url), "utf8"));
const flat = collapseBoot(fx.dialogFrame);

check("real 2.1.323 bytes: detectBlockingDialogSignature names workspace-trust (not the generic footer fallback)",
  detectBlockingDialogSignature(flat) === "workspace-trust");
check("real 2.1.323 bytes: detectNewestBlockingDialogSignature names workspace-trust",
  detectNewestBlockingDialogSignature(flat) === "workspace-trust");
// Old wording kept (matches the existing unit fixture's shape): the question alone, collapsed.
const oldWording = collapseBoot("Is this a project you " + "trust?\n❯ Yes, I trust this folder\n  No\nEnter to confirm · Esc to cancel");
check("older wording still names workspace-trust (both detectors)",
  detectBlockingDialogSignature(oldWording) === "workspace-trust" && detectNewestBlockingDialogSignature(oldWording) === "workspace-trust");
// Negative control: a different dialog with the same footer must NOT be named workspace-trust.
const other = collapseBoot("Some future dialog\nEnter to confirm · Esc to cancel");
check("negative control: unrelated footer dialog stays enter-esc-footer", detectBlockingDialogSignature(other) === "enter-esc-footer");

// ── Card 1e837254: the MID-SESSION detector must not fire on a session's OWN output quoting the question ──
const { detectMidSessionModal } = await import("../dist/pty/host.js");
const quoted = JSON.parse(fs.readFileSync(new URL("./fixtures/1e837254-real-assistant-quoted-trust-question-claude-2.1.323.json", import.meta.url), "utf8")).quotedReplyBytes;
check("positive control: the quoted-reply bytes really contain the question text (the case is falsifiable)",
  detectBlockingDialogSignature(collapseBoot(quoted)) === "workspace-trust");
check("REAL quoted reply (assistant output quoting the question; no echo stripping) is NOT a modal",
  detectMidSessionModal(quoted) === null);
check("REAL genuine trust dialog bytes are still detected as workspace-trust",
  detectMidSessionModal(fx.dialogFrame) === "workspace-trust");
// Fail toward visible: bare question text with NO live-frame chrome after it stays a detection.
check("ambiguous: bare question text with no chrome after it is still detected",
  detectMidSessionModal("Is this a project you trust?\r\n") === "workspace-trust");
// Footer-less / row-less partial shapes: footer alone still holds (generic name); rows alone are structure.
check("footer only (question wording unknown) still yields a modal",
  detectMidSessionModal("Some new dialog\r\nEnter to confirm · Esc to cancel") === "unknown-modal");
check("question + option row, no footer yet, is structure -> detected",
  detectMidSessionModal("Is this a project you trust?\r\n❯ No, exit\r\n  Yes, I trust this folder") === "workspace-trust");
// Sibling signatures that matched on bare text: quoted (chrome after) is not a modal; with footer it is.
const chrome = "\r\n⏵⏵ accept edits on (shift+tab to cycle)";
check("external-imports: bare words in a reply with live chrome after are NOT a modal",
  detectMidSessionModal("● You can allow external imports in CLAUDE.md" + chrome) === null);
check("external-imports: real shape (question + footer) is detected",
  detectMidSessionModal("Allow external CLAUDE.md file imports?\r\n❯ No, disable external imports\r\n  Yes, allow external imports\r\nEnter to confirm · Esc to cancel") === "external-imports");
check("mcp-server-enable: bare tokens in a reply with live chrome after are NOT a modal",
  detectMidSessionModal("● an mcp server may offer reject all" + chrome) === null);
check("mcp-server-enable: bare tokens with no chrome (unconfirmed real shape) stay detected",
  detectMidSessionModal("2 new MCP servers found\r\n❯ Enable\r\n  Reject all") === "mcp-server-enable");
check("quoted full mock dialog followed by the redrawn composer box is NOT a modal",
  detectMidSessionModal("Is this a project you trust?\r\n❯ No, exit\r\n  Yes, I trust this folder\r\nEnter to confirm · Esc to cancel\r\n" + "─".repeat(40) + "❯ ") === null);

if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("ALL PASS");
