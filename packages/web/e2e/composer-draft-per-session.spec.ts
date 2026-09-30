// Composer draft is keyed by SESSION (card 14c68c62) — the regression witness for a cross-session draft
// leak found in full code review. Composer.tsx seeds its draft from the per-session store with a LAZY
// useState initializer (mount-only) but WRITES under whatever `sessionId` it currently holds, and the
// /session/:id route reuses one <SessionView> element across an :id change — so before the fix, deep-
// linking A → B carried A's unfinished text into B's box, saved it INTO B's draft on the next keystroke,
// and would have SENT it to B. That breaks the hard rule that a user's unfinished input is never
// clobbered or misrouted. The fix keys <Composer> on the session id at its sole mount site
// (TerminalCard), so each session gets its own instance and its own draft.
//
// WHAT DRIVES THE TRANSITION, AND WHY. The defect needs a SAME-DOCUMENT :id change — a fresh `page.goto`
// reloads the document, remounts everything, and cannot reproduce it. This spec therefore routes via
// `history.pushState` + a dispatched `popstate`, which is the exact listener react-router 7's browser
// history subscribes to (`PopStateEventType = "popstate"`, lib/router/history.ts) and the same path a
// real in-app `navigate()` / back-forward ends on. Two things stop that from being an unverified
// equivalence: the spec ASSERTS its own precondition (a `window` sentinel planted before the hop must
// survive it — if the document ever reloaded, the transition is not the one under test and the spec
// fails loudly rather than passing for the wrong reason), and it was shown RED against the pre-fix
// bundle and GREEN after.
//
// Seeding (the no-real-claude invariant): both sessions are `processState:"live"` DB rows via
// POST /internal/test/seed (`loomDaemon.seedLiveSession`) — never startSession, which would spawn a real
// claude and trip the fixture's `[pty] spawn` guard. The seeded rows have no pty, so the terminal attach
// is a genuine no-op; every assertion here is on the card's composer, never a live pty stream.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

// The fixture's DEFAULT session-id mint gives every seeded row the same 8-char short id on screen
// ("e2e-live"), which would make the two tiles indistinguishable in the UI. Pass distinct 8-char
// prefixes so `id.slice(0, 8)` — what the tile identity renders — tells A and B apart unambiguously.
const SHORT_A = "e2edrfta";
const SHORT_B = "e2edrftb";

const DRAFT_A = "draft-for-A: do not let this reach session B";
const DRAFT_B = "draft-for-B: B typed this itself";

const SENTINEL = "__loomComposerDraftSpec";

const composerBox = (page: Page) => page.getByPlaceholder("Send a turn to this session", { exact: false });
const sendButton = (page: Page) => page.getByRole("button", { name: "Send turn" });

/** The TILE's own identity node (`<agent> · <short id>`) — scoped, so the SessionView PAGE header's twin
 *  of the same string can never satisfy an assertion about which session the COMPOSER belongs to. */
const tileIdentity = (page: Page, shortId: string) =>
  page.getByTestId("tile-identity").filter({ hasText: shortId });

/** Route to another /session/:id WITHOUT reloading the document, the way an in-app deep-link does.
 *  Mirrors react-router's own history-state shape (`{ usr, key, idx }`) so its pop handler sees a
 *  well-formed entry, then fires the `popstate` it subscribes to. */
async function routeInApp(page: Page, path: string) {
  await page.evaluate((to) => {
    const prev = window.history.state as { idx?: number } | null;
    const idx = typeof prev?.idx === "number" ? prev.idx + 1 : 1;
    const key = Math.random().toString(36).slice(2, 10);
    window.history.pushState({ usr: null, key, idx }, "", to);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, path);
}

/** The precondition this whole spec rests on: the hop above did NOT reload the document, so <SessionView>
 *  (and the <TerminalCard> under it) was REUSED across the :id change — exactly the condition that made
 *  the stale draft reachable. A reload here would silently turn every assertion below into a tautology. */
async function expectSameDocument(page: Page) {
  const alive = await page.evaluate((k) => (window as unknown as Record<string, unknown>)[k], SENTINEL);
  expect(alive, "the in-app hop must not reload the document — otherwise this spec is not exercising the bug").toBe("alive");
}

test("a composer draft stays with its own session across an in-app /session/:id hop", async ({ page, loomDaemon }) => {
  // Both sessions share ONE project so the pair is a single seeded tree; distinct agent names + distinct
  // short ids make each tile's identity assertable on screen.
  const a = await loomDaemon.seedLiveSession({
    id: `${SHORT_A}-${Date.now()}`, role: "plain", agentName: "DraftAgentA",
    ptyGeometry: { cols: 120, rows: 40 }, ptyBytes: "LOOM-DRAFT-A\r\n",
  });
  const b = await loomDaemon.seedLiveSession({
    project: a.project, id: `${SHORT_B}-${Date.now()}`, role: "plain", agentName: "DraftAgentB",
    ptyGeometry: { cols: 120, rows: 40 }, ptyBytes: "LOOM-DRAFT-B\r\n",
  });
  expect(a.sessionId.slice(0, 8)).toBe(SHORT_A);
  expect(b.sessionId.slice(0, 8)).toBe(SHORT_B);

  // ── A: land on it, confirm the tile is A's, and type a draft. ───────────────────────────────────────
  await page.goto(`${loomDaemon.baseURL}/session/${a.sessionId}`);
  await expect(tileIdentity(page, SHORT_A)).toBeVisible();
  await page.evaluate((k) => { (window as unknown as Record<string, unknown>)[k] = "alive"; }, SENTINEL);

  await expect(composerBox(page)).toBeVisible();
  await expect(composerBox(page)).toHaveValue("");
  // pressSequentially, not fill: the defect is about what each KEYSTROKE writes and under which id, so
  // drive the real per-key onChange path rather than one synthetic bulk input event.
  await composerBox(page).pressSequentially(DRAFT_A);
  await expect(composerBox(page)).toHaveValue(DRAFT_A);
  await expect(sendButton(page)).toBeEnabled();

  // ── A → B, in-app. ─────────────────────────────────────────────────────────────────────────────────
  await routeInApp(page, `/session/${b.sessionId}`);
  await expect(tileIdentity(page, SHORT_B)).toBeVisible();
  await expect(tileIdentity(page, SHORT_A)).toHaveCount(0);
  await expectSameDocument(page);

  // THE FIX. Before it, this box held DRAFT_A — A's unfinished text, shown under B, one Send away from
  // reaching the wrong agent. B has no draft of its own, so it must be empty and Send must be disabled.
  await expect(composerBox(page)).toHaveValue("");
  await expect(sendButton(page)).toBeDisabled();

  // Type B's OWN draft. Every keystroke here must be written under B's id and nowhere else.
  await composerBox(page).pressSequentially(DRAFT_B);
  await expect(composerBox(page)).toHaveValue(DRAFT_B);

  // ── Back to A: its draft survived untouched. ───────────────────────────────────────────────────────
  await routeInApp(page, `/session/${a.sessionId}`);
  await expect(tileIdentity(page, SHORT_A)).toBeVisible();
  await expectSameDocument(page);
  // Exactly DRAFT_A — not empty (A's draft was not destroyed by the round trip) and not DRAFT_B (B's
  // keystrokes never landed under A's id).
  await expect(composerBox(page)).toHaveValue(DRAFT_A);

  // ── Forward to B once more: exactly DRAFT_B, so none of A's keystrokes were ever written under B. ──
  await routeInApp(page, `/session/${b.sessionId}`);
  await expect(tileIdentity(page, SHORT_B)).toBeVisible();
  await expectSameDocument(page);
  await expect(composerBox(page)).toHaveValue(DRAFT_B);
});
