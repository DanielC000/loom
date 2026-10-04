// Card a6d7bf36 round 2 — the COMPANION CHAT's credential re-attach, in a real browser.
//
// THE DEFECT, found by Code Review of round 1. That round removed the gateway banner's
// `window.location.reload()` and replaced it with a re-attach nonce (`lib/useCredentialReattach`) that
// two of the app's THREE socket clients hold in their attach-effect deps. `CompanionChat.tsx` was the
// third and was missed: its effect deps were `[sessionId]`. So after a token-dead 1008 close the panel
// went `conn:"revoked"` and stayed there for the life of the component — and the reload that used to
// revive it was gone. Round 1 made the companion panel's dead end PERMANENT where it had been
// self-healing, which is strictly worse than the loop it removed elsewhere.
//
// WHAT THIS PROVES, end to end against a REAL daemon in a REAL browser:
//  1. a token-dead 1008 close really does strand the panel (the precondition — asserted, not assumed);
//  2. re-entering a credential through the banner brings the panel back to `connected` IN PLACE;
//  3. a NEW `/ws/companion` socket was constructed to do it (so (2) is a real re-attach, not a stale
//     pill), while the page itself was never reloaded (a page-lifetime sentinel, because a reload would
//     satisfy "a new socket opened" just as well and prove the opposite of what is claimed);
//  4. the durable transcript was RE-SEEDED on the way back — the effect clears `messages` when it
//     re-runs, so without its own history fetch a re-attached panel would come back EMPTY.
//
// WHY THE 1008 IS DISPATCHED RATHER THAN PROVOKED: identical reasoning to
// `companion-chat-close-kind.spec.ts` — a browser cannot `close(1008)` from a page (InvalidAccessError),
// and this loopback rig has no revocable gateway token of its own to kill. The event is dispatched at the
// live socket, so the component's REAL `onclose`, the REAL shared classifier and the REAL render path all
// run; only the close's ORIGIN is synthetic. The daemon's own side of that contract is pinned in
// `packages/daemon/test/ws-close-reason-contract.mjs`.
//
// SCOPE: a LOOPBACK origin, so the credential re-entered here is a gateway token this page did not need
// in the first place — what matters is that `clearGatewayLock()` runs and the panel reacts to it, which
// is the same edge a proxied page's paste produces. The remote/proxied half of this card (a dead token,
// a bounded ladder, the fleet feed) is covered for real in `gateway-dead-token-bound.spec.ts`.
import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures/daemon";

/** Records every `/ws/companion` socket the page constructs — the COUNT is what separates a genuine
 *  re-attach from a pill that merely re-rendered. Records only; never substitutes the socket, so the chat
 *  connects for real, and the close listener is additive so the app's own `onclose` is never clobbered. */
const INSTRUMENT = () => {
  const w = window as unknown as { __companionWs: WebSocket | null; __companionOpens: number };
  w.__companionWs = null;
  w.__companionOpens = 0;
  const Native = window.WebSocket;
  const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const sock = protocols === undefined ? new Native(url) : new Native(url, protocols);
    if (String(url).includes("/ws/companion")) { w.__companionWs = sock; w.__companionOpens += 1; }
    return sock;
  } as unknown as typeof WebSocket;
  Patched.prototype = Native.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
    Object.defineProperty(Patched, k, { value: Native[k] });
  }
  window.WebSocket = Patched;
};

const companionOpens = () => (window as unknown as { __companionOpens: number }).__companionOpens;

/** Set AFTER load, so it is NOT re-installed by `addInitScript` — a reload therefore wipes it. This is
 *  what makes "re-attached in place" falsifiable: the claim is about the SAME document. */
const NO_RELOAD_SENTINEL = "a6d7bf36-same-document";
const sentinel = () => (window as unknown as { __pageLife?: string }).__pageLife ?? null;

test("re-entering a credential re-attaches the companion chat in place — and re-seeds its history", async ({ page, loomDaemon }) => {
  // A UNIQUE name, because the e2e worker daemon is SHARED and its companion-config rows outlive session
  // archival — sibling specs' companions accumulate in the picker, and the page's "focus the most active
  // companion" tie-break can land on one of theirs.
  const name = `Reattach-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name });
  // One OPEN (current) conversation carrying a distinctive line, so (4) has something to come back to.
  // A single array = one conversation, and the last one is always the live/current one.
  const seeded = `durable turn ${name}`;
  await loomDaemon.seedCompanionConversations(companion.sessionId, [[{ author: "user", text: seeded }]]);

  // Node-side, so it survives the page's own lifecycle and counts the SEED fetch specifically.
  const historyPath = `/api/companion/messages/${encodeURIComponent(companion.sessionId)}`;
  let historyFetches = 0;
  page.on("request", (req) => { if (req.url().includes(historyPath)) historyFetches += 1; });

  await page.addInitScript(INSTRUMENT);
  await page.goto(`${loomDaemon.baseURL}/companion`);
  const chat = page.locator("#companion-panel-chat");
  // FOCUS THIS SPEC'S OWN COMPANION. The picker renders only with 2+ companions, and whether siblings
  // have accumulated on the shared daemon depends on run order — so the CLICK is necessarily conditional.
  // Let the page settle on whatever companion it auto-focuses FIRST. Clicking the picker before the
  // companion list has resolved loses the click: the page's own "focus the most active companion" effect
  // runs after the list lands and overrides a selection made ahead of it.
  await expect(chat.getByText("connected", { exact: true })).toBeVisible();
  const picker = page.getByRole("group", { name: "Select companion" });
  if (await picker.count()) {
    const mine = picker.getByRole("button", { name });
    await mine.click();
    await expect(mine).toHaveAttribute("aria-pressed", "true");
  }
  // UNCONDITIONAL, unlike the click above: it pins the focused companion by name, so a wrong-companion
  // focus fails loudly here instead of silently re-pointing every assertion below at someone else's chat
  // (the failure mode a bare `if (await picker.count())` with no follow-up check hides).
  await expect(chat.getByText(name, { exact: true })).toBeVisible();
  // PRECONDITION, not decoration: the pill reads "connected" only once the real `ws.onopen` fired, so
  // every later state change below is a change rather than an initial render.
  await expect(chat.getByText("connected", { exact: true })).toBeVisible();
  await expect(chat.getByText(seeded)).toBeVisible();
  await page.evaluate((v) => { (window as unknown as { __pageLife: string }).__pageLife = v; }, NO_RELOAD_SENTINEL);
  // A DELTA, not an absolute: focusing this spec's own companion above re-keys the effect on sessionId
  // and so builds a socket of its own, and whether that click happened depends on run order.
  const opensBefore = await page.evaluate(companionOpens);
  expect(opensBefore, "the chat must have attached at least once").toBeGreaterThanOrEqual(1);
  const historyBefore = historyFetches;
  expect(historyBefore, "the load-then-connect seed must have run once").toBeGreaterThanOrEqual(1);

  // ── (1) the panel is stranded by a token-dead close ────────────────────────────────────────────
  const delivered = await page.evaluate(() => {
    const sock = (window as unknown as { __companionWs: WebSocket | null }).__companionWs;
    if (!sock) return false;
    sock.dispatchEvent(new CloseEvent("close", { code: 1008, reason: "gateway token revoked", wasClean: false }));
    return true;
  });
  expect(delivered, "the instrument must have captured the live companion socket").toBe(true);
  await expect(chat.getByText("token revoked", { exact: true })).toBeVisible();
  await expect(chat.getByText("connected", { exact: true })).toHaveCount(0);
  // ...and it is TERMINAL: no reconnect is pending, now or after a full ladder's worth of time. This is
  // the half that makes a re-attach path necessary rather than merely nice.
  await expect(chat.getByText("reconnecting", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(companionOpens), "a 1008 must not be retried").toBe(opensBefore);

  // ── (2)+(3) re-entry through the banner, with no reload ────────────────────────────────────────
  // A REAL token, minted through the REAL loopback REST route a human owner uses, so the banner's
  // verify-then-store chokepoint genuinely passes rather than being stubbed.
  const minted = await fetch(`${loomDaemon.baseURL}/api/gateway-tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `a6d7bf36 ${name}` }),
  });
  expect(minted.ok, `mint failed (${minted.status})`).toBe(true);
  const token = ((await minted.json()) as { plaintext: string }).plaintext;
  expect(token, "a minted token must come back with its plaintext ONCE").toBeTruthy();

  await expect(page.getByText("This access token was revoked.")).toBeVisible();
  await page.getByRole("textbox", { name: "Gateway token" }).fill(token);
  await page.getByRole("button", { name: "Use token" }).click();

  // The banner clearing is `clearGatewayLock()` having run — the edge the nonce watches.
  await expect(page.getByText("This access token was revoked.")).toHaveCount(0);
  await expect(chat.getByText("connected", { exact: true })).toBeVisible();
  await expect(chat.getByText("token revoked", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(companionOpens), "re-attach must build a NEW socket").toBe(opensBefore + 1);
  // THE CONTROL on that count: a reload would also have produced "a new socket" and a "connected" pill.
  expect(await page.evaluate(sentinel), "the page must NOT have reloaded").toBe(NO_RELOAD_SENTINEL);

  // ── (4) the durable transcript came back with it ───────────────────────────────────────────────
  // The effect clears `messages` when it re-runs, so this line is on screen only because the re-keyed
  // effect re-fetched the history. Both halves: the row renders, AND the fetch is observed.
  await expect(chat.getByText(seeded)).toBeVisible();
  expect(historyFetches, "the re-attach must re-seed the durable history").toBeGreaterThan(historyBefore);
});
