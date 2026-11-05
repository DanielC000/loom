// Card 4729d007 — a REMOTE page whose gateway token has exhausted the daemon's per-token request cap.
//
// THE DEFECT. The UI retried a 429 immediately (one test saw 88 requests, 68 of them 429) and the vault tree
// rendered "Empty vault folder." — a claim about a tree that never loaded. Now the shared fetch layer waits out the
// daemon's Retry-After, a "rate limited, retrying" banner says so, and the pane never claims emptiness until the
// tree actually loaded.
//
// HARNESS: ./fixtures/gateway-proxy-rig.ts with a TINY per-token cap. The cap is exhausted from OUTSIDE the page under
// test (a burst of authenticated requests from a shell page), then the Files pane is opened: every request it makes
// is refused until the 60s window slides. That makes recovery deterministic — the page's own idle polling would
// otherwise keep a tiny cap saturated forever, which is a property of the tiny cap, not of the fix.
//
// POSITIVE CONTROL for the absence claim ("the pane does not say Empty while limited"): after recovery the SAME
// pane, same project, same empty vault, DOES say "Empty vault folder." — so the text is reachable and its absence
// during the limited phase is the fix working, not the pane being unable to render it.
import { expect, test } from "@playwright/test";
import { GATEWAY_PROXY_LAUNCH_OPTIONS, GATEWAY_PROXY_RIG_BOOT_TIMEOUT_MS, startGatewayProxyRig, type GatewayProxyRig } from "./fixtures/gateway-proxy-rig";

test.use({ launchOptions: GATEWAY_PROXY_LAUNCH_OPTIONS });

const CAP = 40;
let rig: GatewayProxyRig;
let projectId = "";
test.beforeAll(async () => {
  test.setTimeout(GATEWAY_PROXY_RIG_BOOT_TIMEOUT_MS + 30_000);
  rig = await startGatewayProxyRig({ rateLimit: { perIpPerMin: 100_000, perTokenPerMin: CAP } });
  projectId = (await rig.seedCompanion("ratelimit")).projectId;
});
test.afterAll(async () => { await rig?.stop(); });

test("a rate-limited pane shows the rate-limited state, never 'empty', and recovers after the window", async ({ page, context }) => {
  test.setTimeout(180_000);
  await context.addInitScript((pid) => { try { localStorage.setItem("loom.setupWelcomeDismissed", "1"); localStorage.setItem("loom.projectId", pid); } catch { /* storage blocked */ } }, projectId);

  // 1. Exhaust the token's bucket from a shell page that holds NO token itself (so its own load spends nothing).
  await page.goto(rig.origin + "/");
  const burst = await page.evaluate(async ({ token, n }) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await fetch("/api/version", { headers: { authorization: `Bearer ${token}` } })).status);
    return out;
  }, { token: rig.token, n: CAP + 1 });
  expect(burst.slice(0, CAP).every((s) => s === 200), `the first ${CAP} are within the cap`).toBe(true);
  expect(burst[CAP], "request CAP+1 is refused — the bucket is exhausted").toBe(429);

  // 2. Open the Files pane with the token. Record every vault-tree response (status + Retry-After) it gets.
  await page.evaluate((t) => localStorage.setItem("loom.gatewayToken", t), rig.token);
  // (The tree itself is only requested once the project list — also refused — has loaded, so the refusals are
  // observed across ALL /api/ responses, and the tree separately for the recovery assertion.)
  const apiResponses: { status: number; retryAfter: string | undefined; path: string }[] = [];
  const treeStatuses: number[] = [];
  page.on("response", (r) => {
    const pathname = new URL(r.url()).pathname;
    if (!pathname.startsWith("/api/")) return;
    apiResponses.push({ status: r.status(), retryAfter: r.headers()["retry-after"], path: pathname });
    if (/^\/api\/projects\/[^/]+\/vault$/.test(pathname)) treeStatuses.push(r.status());
  });
  await page.goto(rig.origin + "/repository");

  // 3. LIMITED PHASE: the banner is up, and the pane does not claim the vault is empty.
  await expect(page.getByTestId("rate-limit-banner")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("rate-limit-banner")).toContainText(/retrying in \d+s/);
  await expect(page.getByText("Empty vault folder.")).toHaveCount(0);

  // 4. The daemon told the client how long to wait, and the client did not hammer it meanwhile.
  await expect.poll(() => apiResponses.filter((r) => r.status === 429).length, { message: "the page's requests were refused" }).toBeGreaterThan(0);
  const refused = apiResponses.filter((r) => r.status === 429);
  expect(refused.every((r) => Number(r.retryAfter) >= 1 && Number(r.retryAfter) <= 60), `every refusal carries a sane Retry-After (got ${[...new Set(refused.map((r) => r.retryAfter))].join(",")})`).toBe(true);
  // No retry storm: with Retry-After in the tens of seconds, a further 3s adds only the stragglers of the initial
  // burst. A client that retried immediately re-fires its whole ~27-request load every cycle (the card's
  // 88-requests/68-refused specimen), so the bound separates the two with a wide margin.
  const before = apiResponses.length;
  await page.waitForTimeout(3_000);
  const added = apiResponses.slice(before);
  expect(added.length, `responses in the 3s after the first refusals: ${added.map((r) => `${r.status} ${r.path}`).join(", ")}`).toBeLessThanOrEqual(8);

  // 5. RECOVERY: once the window slides the retry succeeds and the (genuinely empty) tree says so.
  await expect(page.getByText("Empty vault folder.")).toBeVisible({ timeout: 120_000 });
  expect(treeStatuses.includes(200), "the tree eventually loaded with a 200").toBe(true);
});
