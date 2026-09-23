import "./_guard.mjs"; // prod-guard
// Card c8f855e1 — advisory `[loom:prompt-stale]` banner: detector matrix (both directions), composer rules,
// and the REAL PtyHost.spawn wiring (lastPrompt agreement, resume/fork skip, decorator-throw safety).
// RUN: pnpm build (packages/daemon) then `node test/prompt-stale-banner.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-prompt-stale-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { detectFirstRunClaim, composePromptStaleBanner, PROMPT_STALE_TAG, PROMPT_STALE_BOARD_THRESHOLD } =
  await import("../dist/sessions/prompt-stale-banner.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// ---- detector: must FIRE ----
const FIRES = [
  "This is a NEW project with an empty board.",
  "You are the orchestrator. The board is currently empty.",
  "You are starting a brand-new project.",
  "This is the first run — set up everything.",
  "This is a greenfield repo.",
  "There are no cards yet.",
  "The project is brand new.",
  "Context.\nYour board is empty.\nDo the work.",
];
for (const p of FIRES) check(`FIRES: ${JSON.stringify(p)}`, detectFirstRunClaim(p) === true);

// ---- detector: must NOT fire ----
const QUIET = [
  "On a first run, bootstrap the board.",
  "If the board is empty, create the starter cards.",
  "When this is a new project, ask for a brief.",
  "This is not a new project.",
  "Bootstrap the board if needed.",
  "Bootstrap the board.",
  "For a new project, start with a plan.",
  "Treat `This is a new project` as the trigger.",
  'Never say "this is a new project" to users.',
  "```\nThe board is empty.\n```",
  "The board is empty unless a card exists.",
  "Work the board until the board is empty.",
  "Ordinary brief with no claim at all.",
  "",
  // Loom-appended sections are not the standing brief (manager tightening):
  "Clean brief.\n\n[loom:continuation] Handoff. The board is currently empty. This is a fresh seat.",
  "Clean brief.\n\n---\n\n[loom:project-memory] note: This is a new project with an empty board.",
];
for (const p of QUIET) check(`QUIET: ${JSON.stringify(p).slice(0, 80)}`, detectFirstRunClaim(p) === false);
// control: the same continuation text in the BRIEF (before any [loom: tag) does fire — the span rule is what silences it
check("control: continuation text WITHOUT the [loom: tag fires", detectFirstRunClaim("Clean brief.\n\nHandoff. The board is currently empty.") === true);

// ---- composer ----
const STALE = "You are the lead. This is a new project with an empty board.";
let counted = 0;
const ctx = (n, role) => ({ role, countBoardCards: () => { counted++; return n; } });
check("threshold constant is 10", PROMPT_STALE_BOARD_THRESHOLD === 10);
const at10 = composePromptStaleBanner(STALE, ctx(10)); check("10 cards: no banner (boundary)", at10 === STALE);
const at11 = composePromptStaleBanner(STALE, ctx(11));
check("11 cards: banner prepended", at11.startsWith(PROMPT_STALE_TAG) && at11.includes("11 cards"));
check("original brief preserved byte-for-byte after the banner", at11.endsWith(`\n\n${STALE}`));
check("banner is short (<=2 lines of text before the brief)", at11.slice(0, at11.length - STALE.length - 2).split("\n").length <= 2);
counted = 0; composePromptStaleBanner("Clean brief.", ctx(99)); check("no claim ⇒ board count never run", counted === 0);
check("worker role skipped", composePromptStaleBanner(STALE, ctx(99, "worker")) === STALE);
check("manager role bannered", composePromptStaleBanner(STALE, ctx(99, "manager")).startsWith(PROMPT_STALE_TAG));
check("idempotent: already-bannered prompt unchanged", composePromptStaleBanner(at11, ctx(99)) === at11);
check("clean brief + [loom:continuation] 'board is currently empty' ⇒ no banner",
  composePromptStaleBanner("Clean brief.\n\n[loom:continuation] The board is currently empty.", ctx(99)) === "Clean brief.\n\n[loom:continuation] The board is currently empty.");

// ---- real PtyHost.spawn wiring ----
class TestPtyHost extends createSeamHost(PtyHost) {}
const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {}, onBusy() {} };
const base = (id, extra) => ({ sessionId: id, cwd: tmpHome, projectId: "p1", permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, ...extra });
const warns = []; const origWarn = console.warn; console.warn = (...a) => warns.push(a.join(" "));

const host = new TestPtyHost(events, {
  decorateStartupPrompt: ({ projectId, role, prompt }) => composePromptStaleBanner(prompt, { role, countBoardCards: () => (projectId === "p1" ? 50 : (() => { throw new Error("db boom"); })()) }),
});
host.spawn(base("s-fresh", { startupPrompt: STALE, role: "manager" }));
const lf = host.live.get("s-fresh");
check("fresh spawn: startupPrompt is bannered", lf.startupPrompt.startsWith(PROMPT_STALE_TAG) && lf.startupPrompt.endsWith(STALE));
check("fresh spawn: lastPrompt AGREES with startupPrompt", lf.lastPrompt === lf.startupPrompt);
host.spawn(base("s-resume", { resumeId: "eng-1", role: "manager" }));
check("resume: no startupPrompt, untouched", host.live.get("s-resume").startupPrompt === null);
host.spawn(base("s-fork", { resumeId: "eng-1", fork: true, forkSessionId: "eng-2", role: "manager", startupPrompt: STALE }));
check("fork (defensive): prompt not decorated", host.live.get("s-fork").startupPrompt === STALE);
host.spawn(base("s-worker", { startupPrompt: STALE, role: "worker" }));
check("worker: not bannered", host.live.get("s-worker").startupPrompt === STALE);
host.spawn(base("s-throw", { projectId: "p-broken", startupPrompt: STALE, role: "manager" }));
check("decorator throw: spawn still succeeds with the ORIGINAL prompt", host.live.get("s-throw")?.startupPrompt === STALE);
check("decorator throw: a warn was logged", warns.some((w) => w.includes("s-throw")));
const plain = new TestPtyHost(events);
plain.spawn(base("s-nodeco", { startupPrompt: STALE, role: "manager" }));
check("no decorator configured: byte-identical", plain.live.get("s-nodeco").startupPrompt === STALE);
console.warn = origWarn;

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
