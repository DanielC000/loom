// Regression guard for `checkTokenCollision` (gateway/server.ts) — the enabled-bot-token collision guard
// card e8282e02's structural fixture fix (fixtures/daemon.ts: `seedCompanion` now defaults to a FRESH,
// unique token per call, rather than a shared constant) must never accidentally defeat. The default only
// changed WHAT TOKEN a call gets when none is given; passing `botToken` explicitly still lets a spec
// construct a real collision on purpose, and that collision must still be refused.
//
// No UI interaction needed: this hits the REST contract directly, the same layer `checkTokenCollision`
// itself guards. Cleanup is automatic — both seeded companions are tracked by the fixture's own
// `deleteSeededCompanionConfigs`/`archiveSeededSessions`, run by the `autoIsolation` auto fixture after
// this test, so this spec needs no afterEach of its own.
import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures/daemon";

test("checkTokenCollision still refuses a config write that arms a token another enabled companion holds", async ({ page, loomDaemon }) => {
  const token = `123456:e2e-collision-${randomUUID()}`;
  // Companion A: seeded first, holds the token, enabled by default.
  await loomDaemon.seedCompanion({ botToken: token });
  // Companion B: DELIBERATELY seeded with the SAME token — the control's whole point.
  const b = await loomDaemon.seedCompanion({ botToken: token });

  // An otherwise-empty PUT keeps B's own stored (colliding) token and enabled:true unchanged — exactly
  // the write `checkTokenCollision` exists to refuse, since A is a DIFFERENT, still-enabled companion
  // holding the same token.
  const res = await page.request.put(`${loomDaemon.baseURL}/api/companion/config/${b.sessionId}`, {
    headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` },
    data: {},
  });
  expect(res.status(), `expected the guard to refuse this write: ${await res.text()}`).toBe(409);
  const body = await res.json();
  expect(body.error).toContain("already used by another enabled companion");
});
