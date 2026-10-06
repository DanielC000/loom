// Card 28c3ca92 item 2 — the "lock-led Retry note" shape (GatewayTokenBanner.tsx): when a REAL lock (or a
// revocation) leads the banner's headline, the `?gwtoken=` link's own outcome must still render its OWN
// line beside it — `data-testid="gateway-link-note"` — and, when a candidate is genuinely held, the Retry
// button beside THAT. Round 3 (card a1ec70a6) found a lock-led banner that dropped the link copy entirely
// while still rendering a Retry button with nothing explaining it; pre-fix, `!linkLeads && linkCopy` did
// not exist and the note never rendered at all under a lock. Until now this was proven only by
// test/gateway-credential.mjs's source-text scan of the component (`"!linkLeads && linkCopy"` present in
// the JSX) — that scan cannot see whether the DOM actually renders both together against a real daemon.
//
// REPRO SHAPE: a REAL lock (`lockedNow`) plus a held, UNVERIFIED link candidate (`linkOutcome ===
// "unverified"` with something in `pendingGatewayToken()`) — exactly the combination that makes
// `linkLeads` false while `linkCopy` and `retryable` are both true. Reached here by:
//   1. intercepting ONLY the gwtoken capture's own verify call (`GET /api/version`) so it comes back
//      UNANSWERED ("unknown" — never the daemon's real refusal), which holds the candidate for a retry
//      without raising the lock itself (an `"unverified"` outcome never does, by design — see
//      gatewayCredential.ts's `noteGatewayLinkOutcome` call sites);
//   2. letting every OTHER request the page makes run for real against the rig's daemon with no gateway
//      token stored anywhere, which 401s with the real `gateway-token-required` code and raises the
//      ORDINARY lock through the normal `api.ts` path (api.ts:216) — the same mechanism
//      gateway-proxy.spec.ts's first test already relies on for its own banner-on-load assertion.
//
// HARNESS: ./fixtures/gateway-proxy-rig.ts — the same isolated-daemon-behind-a-proxy rig gateway-proxy.spec.ts
// and gateway-token-revoked.spec.ts use, so the page's origin is genuinely non-loopback.
import { expect, test } from "@playwright/test";
import { GATEWAY_PROXY_LAUNCH_OPTIONS, startGatewayProxyRig, type GatewayProxyRig } from "./fixtures/gateway-proxy-rig";

test.use({ launchOptions: GATEWAY_PROXY_LAUNCH_OPTIONS });

let rig: GatewayProxyRig;
test.beforeAll(async () => { rig = await startGatewayProxyRig(); });
test.afterAll(async () => { await rig?.stop(); });
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => { try { localStorage.setItem("loom.setupWelcomeDismissed", "1"); } catch { /* storage blocked */ } });
});

test("a lock-led banner still renders the link's own Retry note beside it, not instead of it", async ({ page }) => {
  let versionCalls = 0;
  // The gwtoken capture's OWN probe, forced to answer NOTHING the daemon ever said — never a 401, which
  // would make this a "rejected" outcome instead of the "unverified" one this case is about.
  await page.route("**/api/version", async (route) => {
    versionCalls++;
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });

  await page.goto(`${rig.origin}/?gwtoken=${encodeURIComponent("a-candidate-nobody-can-verify")}`);

  // PRECONDITION, true whether or not the card's fix holds: this browser holds no gateway token at all, so
  // its ordinary (unrelated) API reads 401 for real and the lock renders — same mechanism as
  // gateway-proxy.spec.ts's very first assertion. This alone proves nothing about the link note.
  await expect(page.getByText("This address needs a gateway token.")).toBeVisible();

  // THE REGRESSION-SENSITIVE PART: the link's own line, rendered BESIDE the lock headline rather than
  // replaced by it. Pre-fix (round <3), a lock-led banner rendered neither this nor the button below.
  const note = page.getByTestId("gateway-link-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("A link's gateway token could not be checked.");
  await expect(note).toContainText(/did not get an answer/i);

  // ...and the Retry button beside it — offered only because a candidate is genuinely HELD.
  await expect(page.getByTestId("gateway-link-retry")).toBeVisible();

  expect(versionCalls, "the verify call must actually have run for this repro to mean anything").toBeGreaterThan(0);
  expect(await page.evaluate(() => localStorage.getItem("loom.gatewayToken")),
    "an unverified candidate must never be stored").toBeNull();
  expect(page.url()).not.toContain("gwtoken"); // stripped from the address bar either way
});
