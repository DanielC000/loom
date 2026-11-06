// Card 1859bfb2: /ws/fleet refuses past the daemon's per-process cap with close 1013 AFTER the upgrade, so
// the browser fires `onopen` for a socket that is about to be refused. FleetSocketProvider used to reset its
// backoff and run the REST seeds on `onopen`, so an over-cap tab retried at the 1 s floor forever with a
// resync burst per attempt. It now resets/seeds only on the server's `hello` frame (sent only on admission).
//
// The refusal is simulated with page.routeWebSocket (the page's socket opens, the route closes it with 1013
// and never connects to the daemon) — the SAME wire shape the daemon's cap produces: open, then 1013.
//
// TEST 1: at the cap, the gap between successive attempts GROWS (the ladder climbs), and the provider's own
// "connected" / "seeded" log lines never appear (those run only on admission and issue the REST seeds). The
// fallback poll is deliberately NOT what this measures — it is a bounded 10 s timer, not a per-attempt burst.
// TEST 2 (positive control for the log instrument): an admitted connection seeds exactly once.
import { expect, test } from "./fixtures/daemon";

const CONNECTED_LOG = "[fleet-ws] connected";
const CAP_REASON = "too many fleet connections";

test.describe("fleet socket at the daemon connection cap (card 1859bfb2)", () => {
  test.setTimeout(60_000);

  test("a refused (1013) fleet socket backs off and never runs the on-connect seeds", async ({ page, loomDaemon }) => {
    const attemptAt: number[] = [];
    const providerLogs: string[] = [];
    page.on("console", (m) => { if (m.text().startsWith("[fleet-ws]")) providerLogs.push(m.text()); });
    await page.routeWebSocket(/\/ws\/fleet/, (ws) => {
      attemptAt.push(Date.now());
      // Close a beat AFTER the page socket opens: the daemon admits the upgrade, then refuses — a close issued
      // synchronously here can beat the page's `onopen` and would not model that.
      setTimeout(() => ws.close({ code: 1013, reason: CAP_REASON }), 100);
    });

    await page.goto(`${loomDaemon.baseURL}/`);
    // Observable: four refused attempts. Pre-fix they arrive ~1 s apart; the ladder takes ~1+2+4 s.
    await expect.poll(() => attemptAt.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);

    const gaps = attemptAt.slice(1, 4).map((t, i) => t - attemptAt[i]!);
    const [g0, g1, g2] = gaps as [number, number, number];
    expect(g2, `retry gaps must grow, got ${JSON.stringify(gaps)}`).toBeGreaterThan(g0 * 2);
    expect(g1, `retry gaps must grow, got ${JSON.stringify(gaps)}`).toBeGreaterThan(g0 * 1.3);
    expect(providerLogs.filter((l) => l === CONNECTED_LOG || /seeded/.test(l)), "no seed may run for a refused socket").toEqual([]);
    // Instrument control: the same capture sees the provider's refusal-path log, so an empty list above is
    // not just a broken console listener.
    expect(providerLogs.some((l) => l.includes("disconnected — falling back to polling"))).toBe(true);
  });

  test("an admitted fleet socket seeds exactly once", async ({ page, loomDaemon }) => {
    const providerLogs: string[] = [];
    page.on("console", (m) => { if (m.text().startsWith("[fleet-ws]")) providerLogs.push(m.text()); });
    await page.routeWebSocket(/\/ws\/fleet/, (ws) => { ws.connectToServer(); });

    await page.goto(`${loomDaemon.baseURL}/`);
    await expect.poll(() => providerLogs.filter((l) => /seeded \d+ session/.test(l)).length, { timeout: 20_000 }).toBe(1);
    await page.waitForLoadState("networkidle");
    expect(providerLogs.filter((l) => l === CONNECTED_LOG).length, "one admission, one connect").toBe(1);
    expect(providerLogs.filter((l) => /seeded \d+ session/.test(l)).length, "exactly one session seed").toBe(1);
  });
});
