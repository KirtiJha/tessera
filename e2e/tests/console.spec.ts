import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * The path a new organisation takes on its first day, in a real browser
 * against a real server: sign up, see a session arrive live, answer its
 * permission prompt, write a policy that the next tool call obeys, and read
 * spend. The reporter's side is driven through its HTTP API with a real
 * device token.
 */

const run = Date.now().toString(36);
const email = `e2e-${run}@tessera-e2e.test`;
const password = "e2e-password-123";
const sessionId = `e2e-${run}`;
const W = { "x-tessera-client": "web" };

let device = "";
let page: Page;

const report = (request: APIRequestContext, session: Record<string, unknown>) =>
  request.post("/api/ingest/report", {
    headers: { authorization: `Bearer ${device}` },
    data: {
      v: 1,
      sentAt: new Date().toISOString(),
      reporter: { kind: "claude-code-hooks", version: "0.1.0" },
      machine: { hostname: "e2e-laptop", machineId: "e2e-machine" },
      session: { id: sessionId, startedAt: new Date(Date.now() - 120_000).toISOString(), model: "claude-sonnet-4-5", cwd: "/work/payments", git: { repo: "acme/payments", branch: "feat/refunds" }, ...session },
      events: [],
    },
  });

test.describe.configure({ mode: "serial" });

// One browser context for the whole journey, as one person would have.
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4700", viewport: { width: 1440, height: 900 } });
});
test.afterAll(async () => {
  await page.close();
});

test("a new organisation signs up and lands on an empty wall", async () => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /sign in/i }).first()).toBeVisible();
  await page.goto("/signup");
  await page.getByLabel("Organisation name").fill(`E2E ${run}`);
  await page.getByLabel("Your name").fill("Erin Example");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create organisation" }).click();
  await page.waitForURL("**/app**");
  await expect(page.getByText("Live wall").first()).toBeVisible();
  // Issue a device token for the reporter, as "Issue a token by hand" does.
  const r = await page.request.post("/api/admin/devices", { headers: W, data: { label: "e2e-laptop" } });
  expect(r.ok()).toBeTruthy();
  device = (await r.json()).token;
  expect(device).toMatch(/^tsr_/);
});

test("a session waiting on a permission prompt appears live and is answered from the console", async () => {
  await page.goto("/app");
  const r = await report(page.request, {
    name: "Refund retries",
    status: "waiting",
    waitReason: "permission",
    openAsk: { id: "ask-e2e", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(pnpm test --filter refunds)", options: [] },
    usageByModel: [{ model: "claude-sonnet-4-5", input: 120_000, output: 8_000, cacheRead: 900_000, cacheWrite: 20_000 }],
  });
  expect(r.ok()).toBeTruthy();
  // Arrives over the stream without a reload.
  const card = page.getByText("Refund retries").first();
  await expect(card).toBeVisible();
  await card.click();
  await page.waitForURL(`**/app/sessions/${sessionId}`);
  await expect(page.getByText("Bash(pnpm test --filter refunds)").first()).toBeVisible();
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText(/session will continue/i)).toBeVisible();
  // The reporter receives the answer.
  const d = await page.request.get(`/api/ingest/sessions/${sessionId}/deliveries`, { headers: { authorization: `Bearer ${device}` } });
  const deliveries = (await d.json()).deliveries as { kind: string; askId: string; payload: { decision: string; by: string } }[];
  expect(deliveries).toEqual([expect.objectContaining({ kind: "answer", askId: "ask-e2e", payload: expect.objectContaining({ decision: "allow", by: "Erin Example" }) })]);
});

test("a policy written in the console decides the next tool call", async () => {
  await report(page.request, { name: "Refund retries", status: "running" });
  await page.goto("/app/policies");
  await page.getByRole("button", { name: /Templates/ }).click();
  await page.getByText("Block secrets files").click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: /Save as version 1/ }).click();
  await expect(page.getByText("Version 1 is in force.")).toBeVisible();
  // The tester agrees with what the server will do.
  await page.getByLabel("Tool").selectOption("Read");
  await page.getByLabel("Command, path or URL").fill("/repo/.env");
  await expect(page.getByText("Denied", { exact: true })).toBeVisible();
  const decide = await page.request.post("/api/ingest/decide", { headers: { authorization: `Bearer ${device}` }, data: { sessionId, tool: "Read", paths: ["/work/payments/config/.env"] } });
  expect(await decide.json()).toMatchObject({ decision: "deny" });
  const ok = await page.request.post("/api/ingest/decide", { headers: { authorization: `Bearer ${device}` }, data: { sessionId, tool: "Read", paths: ["/work/payments/README.md"] } });
  expect(await ok.json()).toMatchObject({ decision: "allow" });
});

test("replay, analytics and the audit log show what happened", async () => {
  await page.goto(`/app/sessions/${sessionId}?tab=replay`);
  await expect(page.getByRole("slider", { name: "Replay position" })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause replay" })).toBeVisible();

  await page.goto("/app/analytics");
  await expect(page.getByText("Estimated spend")).toBeVisible();

  await page.goto("/app/audit");
  await expect(page.getByText("session.answer.allow")).toBeVisible();
  await expect(page.getByText("policy.update")).toBeVisible();
  await page.getByRole("button", { name: "Verify chain" }).click();
  await expect(page.getByText(/Chain intact/)).toBeVisible();
});
