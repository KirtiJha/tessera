import { expect, test } from "@playwright/test";

/**
 * A team's page and a person's page, reached from People and from Analytics,
 * and the change on the period before in the Analytics group list.
 */

const run = `p${Date.now().toString(36)}`;
const W = { "x-tessera-client": "web" };
let device = "";
let teamId = "";
let userId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4700", storageState: { cookies: [], origins: [] } });
  await page.goto("/signup");
  await page.getByLabel("Organisation name").fill(`Profile ${run}`);
  await page.getByLabel("Your name").fill("Pia Profile");
  await page.getByLabel("Work email").fill(`e2e-${run}@tessera-e2e.test`);
  await page.getByLabel("Password").fill("e2e-password-123");
  await page.getByRole("button", { name: "Create organisation" }).click();
  await page.waitForURL("**/app**");
  await page.request.post("/api/admin/teams", { headers: W, data: { name: "Payments" } });
  teamId = (await (await page.request.get("/api/admin/teams", { headers: W })).json()).teams.find((t: { name: string }) => t.name === "Payments").id;
  userId = (await (await page.request.get("/api/auth/me", { headers: W })).json()).user.id;
  await page.request.patch(`/api/admin/users/${userId}`, { headers: W, data: { teamId } });
  device = (await (await page.request.post("/api/admin/devices", { headers: W, data: { label: "e2e-laptop" } })).json()).token;
  // A live session with tokens, so the team has spend today and something on the wall.
  await page.request.post("/api/ingest/report", {
    headers: { authorization: `Bearer ${device}` },
    data: {
      v: 1,
      sentAt: new Date().toISOString(),
      reporter: { kind: "claude-code-hooks", version: "0.1.0" },
      machine: { hostname: "e2e-laptop", machineId: "e2e-machine" },
      session: {
        id: `${run}-live`, name: "Refund retries", status: "running", startedAt: new Date(Date.now() - 300_000).toISOString(), model: "claude-sonnet-4-5", cwd: "/work/payments",
        git: { repo: "acme/payments", branch: "main", worktree: null, ahead: 0, behind: 0, modified: 0 },
        tokens: { input: 400_000, output: 60_000, cacheRead: 0, cacheWrite: 0 },
        usageByModel: [{ model: "claude-sonnet-4-5", input: 400_000, output: 60_000, cacheRead: 0, cacheWrite: 0 }],
      },
      events: [],
    },
  });
  await page.context().storageState({ path: `/tmp/e2e-${run}.json` });
  await page.close();
});

test.use({ storageState: async ({}, use) => use(`/tmp/e2e-${run}.json`) });

test("a team's page shows its members, its live sessions and its spend against the period before", async ({ page }) => {
  await page.goto("/app/people");
  await page.getByRole("link", { name: "Payments" }).click();
  await page.waitForURL(`**/app/teams/${teamId}`);
  await expect(page.getByRole("heading", { name: "Payments", level: 1 })).toBeVisible();
  await expect(page.getByText("Team of 1")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Live now · 1" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Refund retries" }).first()).toBeVisible();
  // Spend arrives with the next rollup of the per-minute samples (at most a minute or so).
  await expect.poll(async () => {
    await page.reload();
    await page.getByRole("heading", { name: "Payments", level: 1 }).waitFor();
    // The member is listed from the start; their spend (and so the "new" chip) only once the rollup has run.
    return page.getByText("new", { exact: true }).count();
  }, { timeout: 120_000, intervals: [5_000] }).toBeGreaterThan(0);
  await page.getByRole("link", { name: "Pia Profile" }).click();
  await page.waitForURL(`**/app/people/${userId}`);
  await expect(page.getByRole("heading", { name: "Pia Profile", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Payments" })).toBeVisible();
});

test("Analytics shows each team's change on the period before, and opens the team", async ({ page }) => {
  await page.goto("/app/analytics");
  const list = page.getByRole("list", { name: "Spend by team" });
  await expect(list.getByRole("link", { name: "Payments" })).toBeVisible({ timeout: 30_000 });
  await expect(list.getByText("new")).toBeVisible();
  await expect(page.getByText(/change on the \d+ days before/)).toBeVisible();
  await list.getByRole("link", { name: "Payments" }).click();
  await page.waitForURL(`**/app/teams/${teamId}`);
});
