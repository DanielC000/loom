// Card d56b12d8 (test gap 3 of card a6d7bf36 round 2) — a COMPANION pane on a REMOTE origin whose held
// gateway token is dead, in a real browser behind a real reverse proxy.
//
// WHY THIS SPEC EXISTS AND WHAT THE EXISTING ONES CANNOT COVER:
//  - `gateway-dead-token-bound.spec.ts` measures the SAME mechanism on the same rig, but on `/ws/fleet`.
//    FleetSocketProvider asks the refusal episode UNCONDITIONALLY, so it reaches the probe by a path the
//    companion panel does not share.
//  - `companion-credential-reattach.spec.ts` drives the companion panel, but on a LOOPBACK origin and
//    from a DISPATCHED 1008 — a close that was authored, classified and terminal before any ladder ran.
//  Neither exercises the companion panel's own never-opened path on a remote origin, which is the one
//  this card's follow-up is about: the upgrade 401s, so no socket opens, the browser sees a bare 1006,
//  and the panel must decide what that means from a credential it cannot read a status off.
//
// THE SHAPE, and why it is built this way. The probe branch is reachable only when the panel's effect has
// NEVER opened a socket under the dead credential — `everOpened` is scoped to the whole effect, so a panel
// that connected before the revoke treats every later close as an ordinary disconnect, by design. So this
// seeds TWO companions and switches to the second one AFTER revoking: the picker click re-keys the effect
// on `sessionId`, giving a genuinely fresh attach under a dead token, which is exactly the real-world race
// (a revoke landing while a pane was between sockets). The first companion's own 1008 close on the way
// through is asserted too, since it is the state the second one must NOT be confused with.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { GATEWAY_PROXY_LAUNCH_OPTIONS, startGatewayProxyRig, type GatewayProxyRig } from "./fixtures/gateway-proxy-rig";

test.use({ launchOptions: GATEWAY_PROXY_LAUNCH_OPTIONS });

let rig: GatewayProxyRig;
let scratch: string;
/** The two seeded companions, in the order they were created. Names are unique per run. */
let companions: { sessionId: string; name: string }[] = [];

/** A loopback POST on the rig's own HUMAN surface. The bearer is mandatory here (proxy mode arms the
 *  loopback guard), and a missing one 401s silently — which reads exactly like a clean no-op. */
async function post<T>(route: string, body: unknown): Promise<T> {
  const res = await fetch(`${rig.loopbackURL}${route}`, {
    method: "POST",
    headers: { ...rig.loopbackAuth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // Read the body ONCE, as text, and parse from that: a template-literal `res.text()` inside the expect
  // message consumes the stream whether or not the assertion fails, and the later `.json()` then throws
  // "Body is unusable" — a failure that names the wrong thing entirely.
  const raw = await res.text();
  expect(res.ok, `POST ${route} failed (${res.status}): ${raw}`).toBe(true);
  return JSON.parse(raw) as T;
}

test.beforeAll(async () => {
  rig = await startGatewayProxyRig();
  scratch = mkdtempSync(path.join(tmpdir(), "loom-e2e-comp-dead-"));
  // ONE project, TWO companions in it. The rig's seed script creates no project (it only seeds what proxy
  // mode needs at boot), so this walks the same REST routes the shared `loomDaemon` fixture's own
  // seedCompanion does, against this rig's isolated daemon.
  const repoPath = path.join(scratch, "repo");
  const vaultPath = path.join(scratch, "vault");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(vaultPath, { recursive: true });
  execFileSync("git", ["init", "-q", repoPath]);
  const project = await post<{ id: string }>("/api/projects", {
    name: `companion-dead-token-${randomUUID().slice(0, 8)}`, repoPath, vaultPath,
  });
  for (const suffix of ["A", "B"]) {
    const name = `Dead${suffix}-${randomUUID().slice(0, 8)}`;
    const agent = await post<{ id: string }>(`/api/projects/${project.id}/agents`, { name });
    const sessionId = `e2e-companion-dead-${suffix}-${randomUUID()}`;
    await post("/internal/test/seed", {
      companionSessions: [{ id: sessionId, projectId: project.id, agentId: agent.id }],
      // A DISTINCT bot token per companion: `checkTokenCollision` refuses a config write arming a token
      // another ENABLED companion already holds (card 02f0e8a6), and two identical seeds would be exactly
      // that state even though the seed route writes directly.
      companionConfigs: [{
        sessionId, enabled: true, name,
        botToken: `1234${suffix}:e2e-dead-token-${randomUUID().slice(0, 8)}`,
        allowedChatId: "999",
      }],
    });
    companions.push({ sessionId, name });
  }
});

test.afterAll(async () => {
  await rig?.stop();
  companions = [];
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Records every `/ws/companion` socket the page CONSTRUCTS, and keeps the live one. The COUNT is the
 *  discriminating instrument: a stopped ladder and a ladder that was never armed look identical in any
 *  rendered state, so the absence claim below is made on a counter a sibling assertion proves can rise.
 *  Records only — it never substitutes the socket, so the panel connects for real. */
const INSTRUMENT = () => {
  const w = window as unknown as { __compOpens: number; __compLast: WebSocket | null; __compCloses: number[] };
  w.__compOpens = 0;
  w.__compCloses = [];
  w.__compLast = null;
  const Native = window.WebSocket;
  const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const sock = protocols === undefined ? new Native(url) : new Native(url, protocols);
    if (String(url).includes("/ws/companion")) {
      w.__compOpens += 1;
      w.__compLast = sock;
      sock.addEventListener("close", (e) => { w.__compCloses.push((e as CloseEvent).code); });
    }
    return sock;
  } as unknown as typeof WebSocket;
  Patched.prototype = Native.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
    Object.defineProperty(Patched, k, { value: Native[k] });
  }
  window.WebSocket = Patched;
};

const compOpens = () => (window as unknown as { __compOpens: number }).__compOpens;
const compCloseCodes = () => (window as unknown as { __compCloses: number[] }).__compCloses;

async function tokenIdByName(name: string): Promise<string> {
  const res = await fetch(`${rig.loopbackURL}/api/gateway-tokens`, { headers: rig.loopbackAuth });
  expect(res.ok, `listing tokens failed (${res.status})`).toBe(true);
  const tokens = (await res.json()) as { id: string; name: string }[];
  // FIXTURE IDENTITY: a stray daemon or a leaked token from another spec fails loudly here rather than
  // letting this revoke something else and still look like it worked.
  const match = tokens.filter((t) => t.name === name);
  expect(match.length, `expected exactly one token named ${name}, saw ${JSON.stringify(tokens.map((t) => t.name))}`).toBe(1);
  return match[0]!.id;
}

test("a dead held token leaves the companion pane terminally refused, not re-handshaking", async ({ page }) => {
  test.setTimeout(120_000); // a real daemon boot is already done; this adds a 14s observation window

  await page.context().addInitScript(INSTRUMENT);
  await page.context().addInitScript((t: string) => {
    try {
      localStorage.setItem("loom.gatewayToken", t);
      localStorage.setItem("loom.setupWelcomeDismissed", "1");
    } catch { /* storage blocked */ }
  }, rig.token);
  await page.goto(`${rig.origin}/companion`);

  const chat = page.locator("#companion-panel-chat");
  const picker = page.getByRole("group", { name: "Select companion" });
  // Let the page settle on whatever it auto-focuses FIRST: its "focus the most active companion" effect
  // runs after the companion list query resolves and would override a selection made ahead of it.
  await expect(chat.getByText("connected", { exact: true })).toBeVisible({ timeout: 30_000 });
  // TWO companions were seeded, so the picker is not conditional here (unlike the shared-daemon specs,
  // where whether siblings exist depends on run order). Assert that, rather than assuming it.
  await expect(picker).toBeVisible();
  const [first, second] = companions;
  const firstBtn = picker.getByRole("button", { name: first!.name });
  const secondBtn = picker.getByRole("button", { name: second!.name });
  await firstBtn.click();
  await expect(firstBtn).toHaveAttribute("aria-pressed", "true");
  // PRECONDITION, not decoration: the pill reads "connected" only once a REAL `ws.onopen` fired through
  // the proxy under a REAL gateway token, so everything below is a change of state rather than a first
  // render — and the recorder is proven able to see this panel's sockets at all.
  await expect(chat.getByText(first!.name, { exact: true })).toBeVisible();
  await expect(chat.getByText("connected", { exact: true })).toBeVisible();
  const openedWhileHealthy = await page.evaluate(compOpens);
  expect(openedWhileHealthy, "the panel must have attached under the live token").toBeGreaterThan(0);

  // ── the credential dies, through the REAL human route ──────────────────────────────────────────
  const tokenId = await tokenIdByName("e2e-proxy");
  const revoked = await fetch(`${rig.loopbackURL}/api/gateway-tokens/${tokenId}`, {
    method: "POST",
    headers: { ...rig.loopbackAuth, "content-type": "application/json" },
    body: JSON.stringify({ status: "revoked" }),
  });
  expect(revoked.ok, `revoke failed (${revoked.status})`).toBe(true);

  // The daemon closes the token's own open sockets with 1008 + an authored reason (card 3c205fb5), so the
  // FOCUSED panel lands in `revoked` — a NAMED change, established by the daemon. Asserted because it is
  // the state the next one must not be confused with, and because it proves the revoke really landed.
  await expect(chat.getByText("token revoked", { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(compCloseCodes), "a live socket's credential dying is a daemon-authored 1008")
    .toContain(1008);

  // ── a FRESH attach under the dead token: never opens, nothing to read off the close ────────────
  // Switching companions re-keys the effect on sessionId, so this attach has `everOpened === false` —
  // the only state in which the panel asks the held-token probe at all.
  await secondBtn.click();
  await expect(secondBtn).toHaveAttribute("aria-pressed", "true");
  await expect(chat.getByText(second!.name, { exact: true })).toBeVisible();
  const attempted = await page.evaluate(compOpens);
  expect(attempted, "switching companions must have attempted a socket of its own").toBeGreaterThan(openedWhileHealthy);
  // The browser sees 1006, NOT the daemon's 1008: the upgrade was rejected, so there was never a socket
  // for the daemon to close with a reason. That is the whole reason a probe is needed here.
  await expect.poll(() => page.evaluate(compCloseCodes).then((c) => c.filter((x) => x === 1006).length), { timeout: 30_000 })
    .toBeGreaterThan(0);

  // THE VERDICT. `token refused` is reachable from exactly ONE place in the component — `stopForRefusal`,
  // run only by the refusal episode's `onDead`, run only by the held-token probe answering `invalid`. So
  // this pill IS the attribution: it cannot be reached by "nothing ever tried", by a 1008, or by a
  // missing credential, each of which paints a different pill. No log line is needed for it.
  await expect(chat.getByText("token refused", { exact: true })).toBeVisible({ timeout: 30_000 });
  const settled = await page.evaluate(compOpens);

  // ...AND IT IS TERMINAL. A draft is typed FIRST so that Send being disabled is attributable to the
  // connection state alone — `canSend` also gates on a non-empty draft, so asserting it on an empty
  // composer would pass whatever the pill said.
  await chat.getByLabel("Message").fill("this must not be sendable");
  await expect(chat.getByRole("button", { name: "Send" })).toBeDisabled();

  // THE DISCRIMINATING ABSENCE CLAIM: no further upgrades. The capped ladder would have fired at 1s, 2s,
  // 4s and 8s inside this window — and a rejected WS upgrade spends the trusted proxy's ONE shared
  // PROXY_FAILED_AUTH_PER_MIN bucket, so this is what 429s unrelated remote callers. The POSITIVE CONTROL
  // for the counter is above, on this same instrument and this same page: it rose for the healthy attach
  // and again for the switch, so a flat count here is a real absence rather than a blind one.
  await page.waitForTimeout(14_000);
  expect(await page.evaluate(compOpens),
    "a refused held credential must not keep re-handshaking the companion socket").toBe(settled);
  await expect(chat.getByText("token refused", { exact: true })).toBeVisible();
  await expect(chat.getByText("reconnecting", { exact: true })).toHaveCount(0);
  // The re-entry surface is still on screen, which is what makes stopping safe at all (card a6d7bf36).
  await expect(page.getByLabel("Gateway token")).toBeVisible();
});
