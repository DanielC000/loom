// A stored connection whose host field holds a URL (written before host validation existed) is badged
// "Invalid host" in the Connections list, while a valid row is not — measured against the real daemon's own
// metadata, and the daemon REFUSES to create such a row through the REST route in the first place.
//
// The bad row cannot be created through the API any more, so it is made the only way it can still exist: a
// valid row is created over REST, then its host column is rewritten directly in this fixture daemon's OWN
// scratch DB (`loomDaemon.loomHome`, the documented exception for out-of-band state). Nothing real is touched.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/daemon";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database: any = createRequire(path.resolve(__dirname, "..", "..", "daemon", "package.json"))("better-sqlite3");

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function postConnection(baseURL: string, body: Record<string, unknown>) {
  return fetch(`${baseURL}/api/connections`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("a url-in-host connection is refused at create, and an existing one is badged Invalid host", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("conn-host"));
  const badName = uniq("plex-bad");
  const goodName = uniq("plex-good");

  // Create-time refusal: a clear 400 naming the scheme, and nothing persisted.
  const refused = await postConnection(loomDaemon.baseURL, { name: uniq("refused"), host: "http://192.168.178.136:32400", authScheme: "api-key", secret: "s" });
  expect(refused.status).toBe(400);
  const refusedText = await refused.text();
  expect(refusedText).toMatch(/remove the scheme/);
  expect(refusedText).toMatch(/host\[:port\].*HTTPS by default.*Allow plain HTTP/);

  const bad = (await (await postConnection(loomDaemon.baseURL, { name: badName, host: "plex.lan:32400", authScheme: "api-key", secret: "s" })).json()) as { id: string };
  const good = (await (await postConnection(loomDaemon.baseURL, { name: goodName, host: "good.lan:32400", authScheme: "api-key", secret: "s" })).json()) as { id: string };
  expect(bad.id).toBeTruthy();

  const db = new Database(path.join(loomDaemon.loomHome, "loom.db"));
  try {
    db.prepare("UPDATE connections SET host = ? WHERE id = ?").run("http://192.168.178.136:32400", bad.id);
  } finally {
    db.close();
  }

  try {
    // The daemon's own read agrees before the UI is consulted.
    const rows = (await (await fetch(`${loomDaemon.baseURL}/api/connections`)).json()) as Array<{ id: string; invalidHost?: boolean }>;
    expect(rows.find((r) => r.id === bad.id)?.invalidHost).toBe(true);
    expect(rows.find((r) => r.id === good.id)?.invalidHost).toBeUndefined();

    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await page.goto(`${loomDaemon.baseURL}/home?tab=settings`);
    const badRow = page.getByTestId(`connection-row-${bad.id}`);
    await expect(badRow).toBeVisible();
    await expect(badRow.getByTestId("connection-invalid-host")).toHaveText("Invalid host");
    await expect(page.getByTestId(`connection-row-${good.id}`).getByTestId("connection-invalid-host")).toHaveCount(0);
  } finally {
    for (const id of [bad.id, good.id]) await fetch(`${loomDaemon.baseURL}/api/connections/${id}`, { method: "DELETE" });
  }
});
