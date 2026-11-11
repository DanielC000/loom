// Card 2d8acbea: creating a connection under a name another connection already holds is refused (409), and
// a pre-existing duplicate pair (made before that refusal existed) is flagged "Duplicate name" on BOTH rows
// in Settings -> Connections, while a uniquely named row carries no flag. Nothing is renamed or deleted.
//
// The duplicate pair cannot be created through the API any more, so it is made the only way it can still
// exist: two valid rows over REST, then one name rewritten directly in this fixture daemon's OWN scratch DB
// (`loomDaemon.loomHome`, the documented exception for out-of-band state). Nothing real is touched.
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

test("a duplicate create is refused 409, and an existing duplicate pair is flagged on both rows", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("conn-dup"));
  const dupName = uniq("dup");
  const body = (name: string) => ({ name, host: "dup.lan:8080", authScheme: "api-key", secret: "s" });

  const a = (await (await postConnection(loomDaemon.baseURL, body(dupName))).json()) as { id: string };
  const b = (await (await postConnection(loomDaemon.baseURL, body(uniq("other")))).json()) as { id: string };
  const lone = (await (await postConnection(loomDaemon.baseURL, body(uniq("lone")))).json()) as { id: string };

  const refused = await postConnection(loomDaemon.baseURL, body(dupName));
  expect(refused.status).toBe(409);
  expect(await refused.text()).toMatch(/already exists/);

  const db = new Database(path.join(loomDaemon.loomHome, "loom.db"));
  try {
    db.prepare("UPDATE connections SET name = ? WHERE id = ?").run(dupName, b.id);
  } finally {
    db.close();
  }

  try {
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await page.goto(`${loomDaemon.baseURL}/home?tab=settings`);
    for (const id of [a.id, b.id]) {
      const row = page.getByTestId(`connection-row-${id}`);
      await expect(row).toBeVisible();
      await expect(row.getByTestId("connection-duplicate-name")).toHaveText("Duplicate name");
      await expect(row.getByTestId("connection-duplicate-name")).toHaveAttribute("title", /Another connection has this name; rename one/);
    }
    await expect(page.getByTestId(`connection-row-${lone.id}`)).toBeVisible();
    await expect(page.getByTestId(`connection-row-${lone.id}`).getByTestId("connection-duplicate-name")).toHaveCount(0);
  } finally {
    for (const id of [a.id, b.id, lone.id]) await fetch(`${loomDaemon.baseURL}/api/connections/${id}`, { method: "DELETE" });
  }
});
