// Card 04314fbc — the companion chat's TWO terminal close states, rendered, in a real browser.
//
// THE DEFECT: `CompanionChat.tsx` turned ANY 1008 close into `conn = "revoked"` and painted the red
// "token revoked" pill. Two unrelated producers send 1008 (see docs/decisions/f8d2684d-…): a gateway-token
// status change, where the browser's credential really is dead and the page banner is the re-entry; and a
// per-socket policy refusal, where the credential is FINE. Collapsing them told a user with a perfectly
// good token to go re-paste it. `Terminal.tsx` already branched on the verdict kind, so the two call sites
// had drifted.
//
// ⚠️ WHAT THE INSTRUMENT IS, AND WHAT IT THEREFORE CANNOT PROVE. The close is delivered by dispatching a
// real `CloseEvent` on the live socket, which invokes the app's own assigned `onclose` — so the component's
// REAL handler, the REAL shared classifier, and the REAL render path all run. What it does NOT prove is
// that any daemon ever sends a non-token 1008 on `/ws/companion`: today none does (the only other producer
// is the host-shell refusal on `/ws/term`, decision 710a34fa), which is exactly why this branch is
// unreachable by seeding and why a synthetic event is the only way to render it at all. The daemon's own
// side of that contract — which code and which reason each producer actually sends — is pinned separately
// and for real in `packages/daemon/test/ws-close-reason-contract.mjs`.
//
// A browser also cannot SEND 1008 from a page (`close(1008, …)` throws InvalidAccessError; only 1000 and
// 3000-4999 are allowed), so closing the socket for real is not an option here either.
//
// ⭐ CONTROL: each assertion's sibling runs the OTHER reason through the SAME instrument on the SAME socket,
// so neither state can pass by accident — "refused, not revoked" would read identically if the instrument
// simply never fired, and "revoked" would read identically if every 1008 still collapsed to it.
import { expect, test } from "./fixtures/daemon";

/** Records the last `/ws/companion` socket the page constructs, so a test can hand its `onclose` a close
 *  event of its choosing. Records only — never substitutes the socket, so the chat still connects for real
 *  (which is what makes the "connected" pill a real precondition rather than a styled div). */
const INSTRUMENT = () => {
  const w = window as unknown as { __companionWs: WebSocket | null };
  w.__companionWs = null;
  const Native = window.WebSocket;
  const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const sock = protocols === undefined ? new Native(url) : new Native(url, protocols);
    if (String(url).includes("/ws/companion")) w.__companionWs = sock;
    return sock;
  } as unknown as typeof WebSocket;
  Patched.prototype = Native.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
    Object.defineProperty(Patched, k, { value: Native[k] });
  }
  window.WebSocket = Patched;
};

async function openConnectedChat(page: import("@playwright/test").Page, baseURL: string) {
  await page.addInitScript(INSTRUMENT);
  await page.goto(`${baseURL}/companion`);
  const chat = page.locator("#companion-panel-chat");
  // The REAL socket must be open first: the pill only reads "connected" once `ws.onopen` fired, so this is
  // the precondition that makes a later state change a change rather than an initial render.
  await expect(chat.getByText("connected", { exact: true })).toBeVisible();
  return chat;
}

/** Fire a 1008 close with `reason` at the live companion socket's own handler. */
async function close1008(page: import("@playwright/test").Page, reason: string) {
  const delivered = await page.evaluate((r) => {
    const sock = (window as unknown as { __companionWs: WebSocket | null }).__companionWs;
    if (!sock) return false;
    sock.dispatchEvent(new CloseEvent("close", { code: 1008, reason: r, wasClean: false }));
    return true;
  }, reason);
  expect(delivered, "the instrument must have captured the live companion socket").toBe(true);
}

test("an UNRECOGNISED 1008 reason reads as refused, never as a revoked token", async ({ page, loomDaemon }) => {
  await loomDaemon.seedCompanion();
  const chat = await openConnectedChat(page, loomDaemon.baseURL);

  // The host-shell refusal's own reason — a real daemon string, and deliberately NOT one of the four
  // gateway-token changes. The shared classifier returns {kind:"policy"} for it.
  await close1008(page, "host shell terminals are loopback-only");

  // BEFORE → AFTER: connected → refused, with the credential claim nowhere on the page.
  await expect(chat.getByText("refused", { exact: true })).toBeVisible();
  await expect(chat.getByText("connected", { exact: true })).toHaveCount(0);
  await expect(chat.getByText("token revoked", { exact: true })).toHaveCount(0);
  // ...and it is TERMINAL, not a transient gap: no "reconnecting" pill, now or after a full ladder's worth
  // of time (1+2+4+8s would all have fired inside this window had the retry branch been taken).
  await expect(chat.getByText("reconnecting", { exact: true })).toHaveCount(0);

  // Send is off, because the state is terminal — `canSend` gates on "connected".
  await page.getByRole("textbox", { name: "Message" }).fill("should not be sendable");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  // No credential surface was raised: the whole point is that this token is fine.
  await expect(page.getByText("This access token was")).toHaveCount(0);
});

test("CONTROL: a gateway-token 1008 on the SAME socket still reads as a revoked token", async ({ page, loomDaemon }) => {
  // Without this, the test above passes identically for a build that renders "refused" for EVERY 1008 —
  // i.e. for the same collapse, merely relabelled. Same instrument, same socket, only the reason differs.
  await loomDaemon.seedCompanion();
  const chat = await openConnectedChat(page, loomDaemon.baseURL);

  await close1008(page, "gateway token revoked");

  await expect(chat.getByText("token revoked", { exact: true })).toBeVisible();
  await expect(chat.getByText("refused", { exact: true })).toHaveCount(0);
  await expect(chat.getByText("connected", { exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message" }).fill("should not be sendable");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
});
