import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * The session page: a file's diff fetched from the machine when someone opens
 * it, a timeline mark that opens the replay at its moment (and a link to that
 * moment that survives a reload), and the card that sums up an ended session.
 * The test plays the machine's part with the device token.
 */

const run = `s${Date.now().toString(36)}`;
const W = { "x-tessera-client": "web" };
let device = "";
const auth = () => ({ authorization: `Bearer ${device}` });

const report = (request: APIRequestContext, session: Record<string, unknown>, extra: Record<string, unknown> = {}, events: unknown[] = []) =>
  request.post("/api/ingest/report", {
    headers: auth(),
    data: {
      v: 1,
      sentAt: new Date().toISOString(),
      reporter: { kind: "claude-code-hooks", version: "0.1.0" },
      machine: { hostname: "e2e-laptop", machineId: "e2e-machine" },
      session: { startedAt: new Date(Date.now() - 20 * 60_000).toISOString(), model: "claude-sonnet-4-5", cwd: "/work/payments", git: { repo: "acme/payments", branch: "feat/refunds", worktree: null, ahead: 1, behind: 0, modified: 2 }, ...session },
      events,
      ...extra,
    },
  });

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4700", storageState: { cookies: [], origins: [] } });
  await page.goto("/signup");
  await page.getByLabel("Organisation name").fill(`Session ${run}`);
  await page.getByLabel("Your name").fill("Sam Session");
  await page.getByLabel("Work email").fill(`e2e-${run}@tessera-e2e.test`);
  await page.getByLabel("Password").fill("e2e-password-123");
  await page.getByRole("button", { name: "Create organisation" }).click();
  await page.waitForURL("**/app**");
  device = (await (await page.request.post("/api/admin/devices", { headers: W, data: { label: "e2e-laptop" } })).json()).token;
  await page.context().storageState({ path: `/tmp/e2e-${run}.json` });
  await page.close();
});

test.use({ storageState: async ({}, use) => use(`/tmp/e2e-${run}.json`) });

test("opening a changed file asks the machine for its diff and shows it, numbered and coloured", async ({ page }) => {
  const id = `${run}-diff`;
  const files = [
    { path: "src/refunds.ts", status: "modified", added: 2, removed: 1 },
    { path: "src/retry.ts", status: "untracked", added: 2, removed: 0 },
  ];
  await report(page.request, { id, name: "Refund retries", status: "running", filesChanged: files });
  await page.goto(`/app/sessions/${id}`);
  await expect(page.getByText("Open a file to see its diff, fetched from e2e-laptop when you ask.")).toBeVisible();
  await page.getByRole("button", { name: /src\/refunds\.ts/ }).click();
  await expect(page.getByText("Asking e2e-laptop for the diff…")).toBeVisible();

  // The machine's keep-alive takes the request with its next report, and answers it.
  const ack = await (await report(page.request, { id, status: "running", filesChanged: files }, { claimKinds: ["command"] })).json();
  const cmd = ack.deliveries.find((d: { kind: string }) => d.kind === "command");
  expect(cmd.payload.op).toBe("diff");
  const up = await page.request.post(`/api/ingest/sessions/${id}/diff`, {
    headers: auth(),
    data: {
      requestId: cmd.payload.requestId,
      files: [
        { path: "src/refunds.ts", status: "modified", diff: "diff --git a/src/refunds.ts b/src/refunds.ts\n--- a/src/refunds.ts\n+++ b/src/refunds.ts\n@@ -10,3 +10,4 @@ export function refund() {\n   const r = client();\n-  return r.send();\n+  const retries = 3;\n+  return r.send({ retries });\n }\n" },
        { path: "src/retry.ts", status: "untracked", diff: "--- /dev/null\n+++ b/src/retry.ts\n@@ -0,0 +1,2 @@\n+export const backoff = 250;\n+export const max = 3;\n" },
      ],
    },
  });
  expect(up.ok()).toBeTruthy();

  await expect(page.getByText(/^From e2e-laptop at .*asked by Sam Session\. Held 15 minutes, never stored\.$/)).toBeVisible();
  const table = page.locator("table").first();
  await expect(table.getByText("const retries = 3;")).toBeVisible();
  // The removed line keeps its old number, 11; the added ones take new numbers 11 and 12.
  await expect(table.locator("tr", { hasText: "return r.send();" }).locator("td").first()).toHaveText("11");
  await expect(table.locator("tr", { hasText: "return r.send({ retries });" }).locator("td").nth(1)).toHaveText("12");
  await page.getByRole("button", { name: /src\/retry\.ts/ }).click();
  await expect(page.getByText("export const backoff = 250;")).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh diffs" })).toBeVisible();
});

test("a failure on the timeline opens the replay at that moment, and the link keeps it", async ({ page }) => {
  const id = `${run}-replay`;
  const failAt = new Date(Date.now() - 8 * 60_000).toISOString();
  await report(page.request, { id, name: "Flaky refunds", status: "running" }, {}, [{ id: "f1", ts: failAt, kind: "tool.fail", text: "Bash(pnpm test) failed: 2 tests failed" }]);
  await page.goto(`/app/sessions/${id}`);
  await page.locator("svg path[fill='var(--color-rose-400)']").first().click();
  await expect(page).toHaveURL(/tab=replay&t=\d+/);
  const t = Number(new URL(page.url()).searchParams.get("t"));
  expect(t).toBeGreaterThanOrEqual(11 * 60);
  expect(t).toBeLessThanOrEqual(13 * 60);
  await expect(page.locator("li span[title='Bash(pnpm test) failed: 2 tests failed']")).toBeVisible();
  await page.reload();
  await expect(page.locator("li span[title='Bash(pnpm test) failed: 2 tests failed']")).toBeVisible();
  expect(Number(new URL(page.url()).searchParams.get("t"))).toBe(t);
});

test("an ended session opens with a card that says how it went", async ({ page }) => {
  const id = `${run}-ended`;
  await report(page.request, {
    id, name: "Ledger export", status: "ended", endedAt: new Date().toISOString(), endReason: "exit",
    tokens: { input: 2000, output: 1500, cacheRead: 18000, cacheWrite: 0 },
    toolCalls: { Read: 40, Bash: 12, Edit: 6 },
    filesChanged: [{ path: "src/export.ts", status: "modified", added: 30, removed: 4 }],
    plan: { title: "Export", steps: [{ id: "1", title: "Query", status: "completed" }, { id: "2", title: "CSV", status: "completed" }, { id: "3", title: "Upload", status: "pending" }] },
  });
  await page.goto(`/app/sessions/${id}`);
  const card = page.getByRole("region", { name: "Session summary" });
  await expect(card.getByRole("heading", { name: /^Finished after (19m|20m)/ })).toBeVisible();
  await expect(card.getByText("Left 1 file changed and 1 commit to push.")).toBeVisible();
  await expect(card.getByText("Plan:")).toContainText("2 of 3 steps done");
  await expect(card.getByText("Most used:")).toContainText("Read 40 · Bash 12 · Edit 6");
  await card.getByRole("button", { name: "Replay from the start" }).click();
  await expect(page).toHaveURL(/tab=replay&t=0/);
});

test("the numbers say how they are worked out, by keyboard and by tap", async ({ page }) => {
  await page.goto(`/app/sessions/${run}-ended`);
  const help = page.getByRole("button", { name: "How est. cost is worked out" });
  await help.focus();
  await expect(page.getByRole("tooltip")).toContainText("model prices");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  await help.click();
  await expect(page.getByRole("tooltip")).toContainText("An estimate");
  await page.locator("body").click({ position: { x: 5, y: 500 } });
  await expect(page.getByRole("tooltip")).toBeHidden();
});

test("explaining failures cannot be turned on without a Claude API key on the server", async ({ page }) => {
  await page.goto("/app/data");
  await expect(page.getByText("Needs a Claude API key on the server (ANTHROPIC_API_KEY).", { exact: false })).toBeVisible();
  // No "Explain this failure" anywhere while it is off.
  await page.goto(`/app/sessions/${run}-replay`);
  await expect(page.getByRole("heading", { name: "Flaky refunds" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Explain this failure" })).toHaveCount(0);
});

