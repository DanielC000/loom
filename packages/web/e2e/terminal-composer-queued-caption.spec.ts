// Composer queued-send feedback — the "queued #N — sends when the turn ends" caption under the composer
// is GONE (fix(web): the ledger bar makes it redundant, owner-directed 2026-07-06). When a human send
// queues (session busy), the composer must NOT print that caption: the ledger bar (SessionQueue) already
// surfaces every held message, so the caption only duplicated it and padded the composer away from the
// card's bottom edge. Here we drive the REAL composer (type → Send turn) into a queued state and assert
// the caption never appears, while the ledger bar DOES pick the message up.
//
// Hermetic, same recipe as terminal-queue-ledger.spec: seed the End-User Platform "Operator session" as a
// CANNED-pty tile, arm it busy with ONE delivered POST /input, then send through the COMPOSER so the send
// is HELD (position, not delivered) — exactly the "Send while busy" path the caption used to annotate.
import { expect, test } from "./fixtures/daemon";

const CAPTION = /sends when the turn ends/;

test("a queued composer send shows NO 'queued … sends when the turn ends' caption — the ledger bar carries it", async ({ page, loomDaemon }) => {
  // Resolve the reserved Platform home + its operator agent exactly as EndUserPlatformView does.
  const home = await (await fetch(`${loomDaemon.baseURL}/api/setup/home`)).json();
  const profiles = await (await fetch(`${loomDaemon.baseURL}/api/profiles`)).json();
  const roleOf = (a: { profileId?: string | null }) =>
    profiles.find((p: { id: string; role: string }) => p.id === a.profileId)?.role ?? null;
  const operator = home.agents.find((a: { profileId?: string | null }) => roleOf(a) === "setup")
    ?? home.agents.find((a: { name: string }) => a.name === "Platform");
  expect(operator, "the reserved Platform home should seed an operator agent").toBeTruthy();

  // Production-like 120×40 grid: WIDTH-bound in the operator tile, so the terminal hugs its grid and the
  // composer sits flush + stable (unlike the ledger spec's deliberately height-bound 80×40, whose font
  // settle jitters the composer 1px and would make a "Send turn" click never see a stable target).
  const seeded = await loomDaemon.seedLiveSession({
    project: { id: home.project.id, name: home.project.name },
    agentId: operator.id,
    role: "setup",
    ptyGeometry: { cols: 120, rows: 40 },
    ptyBytes: "LOOM-COMPOSER-CAPTION\r\nqueue a turn and the caption is gone\r\n",
  });

  await page.goto(`${loomDaemon.baseURL}/platform`);
  await expect(page.getByText("Operator session", { exact: false }).first()).toBeVisible();
  await page.waitForTimeout(700); // let the height-budget measure + font scale settle before interacting

  // Arm the canned session busy so the NEXT send is held in the FIFO rather than delivered.
  const armed = await (await fetch(`${loomDaemon.baseURL}/api/sessions/${seeded.sessionId}/input`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "first turn — delivers and arms busy" }),
  })).json();
  expect(armed.delivered).toBe(true);

  // The caption never existed at rest.
  await expect(page.getByText(CAPTION)).toHaveCount(0);

  // Drive the REAL composer: type a message and click Send turn. The session is busy, so this queues.
  const box = page.getByPlaceholder("Send a turn to this session", { exact: false });
  await expect(box).toBeVisible();
  const QUEUED = "queued via the composer while busy — no caption, just the ledger";
  await box.fill(QUEUED);
  await page.getByRole("button", { name: "Send turn" }).click({ force: true });

  // The ledger bar picks the queued message up (the composer invalidates the queue query on send, so this
  // is near-instant rather than waiting out the 3s poll).
  await expect(page.getByText(/Queued \(1\)/)).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId("queue-ledger-bar").getByText(QUEUED, { exact: false })).toBeVisible();

  // THE ASSERTION: the old caption is nowhere on the page — not under the composer, not anywhere.
  await expect(page.getByText(CAPTION)).toHaveCount(0);
  // The composer cleared (the send went through), leaving the box empty and ready.
  await expect(box).toHaveValue("");
});
