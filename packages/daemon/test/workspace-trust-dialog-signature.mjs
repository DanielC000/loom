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

if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("ALL PASS");
