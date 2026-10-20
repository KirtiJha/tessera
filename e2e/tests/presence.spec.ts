import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * A new person's first minutes, and the console/terminal hand-off: the guided
 * first run ticks itself off, away mode is one click and sticks, a prompt
 * shows how long it can still be answered here and then says plainly that the
 * terminal has it, and prompts people keep approving become one-click rules.
 */

const run = `p${Date.now().toString(36)}`;
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
      session: { startedAt: new Date(Date.now() - 120_000).toISOString(), model: "claude-sonnet-4-5", cwd: "/work/app", git: { repo: "acme/app", branch: "main" }, ...session },
      events: [],
    },
  });

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4700", viewport: { width: 1440, height: 900 } });
});
test.afterAll(async () => {
  await page.close();
});

test("an empty wall walks a new person through their first session", async () => {
  await page.goto("/signup");
  await page.getByLabel("Organisation name").fill(`Presence ${run}`);
  await page.getByLabel("Your name").fill("Pia Present");
  await page.getByLabel("Work email").fill(`e2e-${run}@tessera-e2e.test`);
  await page.getByLabel("Password").fill("e2e-password-123");
  await page.getByRole("button", { name: "Create organisation" }).click();
  await page.waitForURL("**/app**");
  await page.goto("/app");
  await expect(page.getByText("Let's get your first session on the wall")).toBeVisible();
  await expect(page.getByRole("link", { name: "Get the install line" })).toBeVisible();
  // Connecting a machine ticks step one by itself and moves on to starting a session.
  device = (await (await page.request.post("/api/admin/devices", { headers: W, data: { label: "e2e-laptop" } })).json()).token;
  await expect(page.getByText(/Run\s+claude\s+in any project/)).toBeVisible({ timeout: 15_000 });
});

test("away mode is one click in the top bar, shows plainly, and sticks", async () => {
  await page.getByRole("button", { name: /^Answering: Either/ }).click();
  // The choice is saved before the reload that checks it sticks.
  await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/me/preferences") && r.request().method() === "PUT"), page.getByRole("menuitem", { name: /^Away/ }).click()]);
  await expect(page.getByRole("button", { name: /^Answering: Away/ })).toContainText("Away");
  await page.reload();
  await expect(page.getByRole("button", { name: /^Answering: Away/ })).toBeVisible();
  await page.goto("/app/settings");
  await expect(page.getByRole("radio", { name: /Away/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Prompts wait up to 10 minutes for you here or on your phone.").first()).toBeVisible();
  // The reporter is told on its next report.
  const ack = await (await report(page.request, { id: `${run}-ack`, status: "running" })).json();
  expect(ack.presence).toBe("away");
});

test("a prompt counts down while it can be answered here, then says the terminal has it", async () => {
  const id = `${run}-handoff`;
  const ask = { id: "h1", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(pnpm db:migrate)", detail: { command: "pnpm db:migrate" }, answerableUntil: new Date(Date.now() + 90_000).toISOString() };
  await report(page.request, { id, name: "Migration", status: "waiting", waitReason: "permission", openAsk: ask });
  await page.goto(`/app/sessions/${id}`);
  await expect(page.getByText(/answer here within (1|2) min/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
  // The reporter's wait ran out: the terminal shows its dialog now.
  await report(page.request, { id, name: "Migration", status: "waiting", waitReason: "permission", openAsk: { ...ask, answerableUntil: null, inTerminal: true } });
  await expect(page.getByText("Now waiting in the terminal on e2e-laptop.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow once" })).toBeHidden();
  // And the wall card says so too.
  await page.goto("/app");
  await expect(page.locator("a", { hasText: "Migration" }).first().getByText("Waiting in the terminal")).toBeVisible();
});

test("a command people keep approving becomes a one-click rule that skips the prompt", async () => {
  const id = `${run}-lint`;
  for (let i = 0; i < 5; i++) {
    await report(page.request, { id, name: "Lint fixes", status: "waiting", waitReason: "permission", openAsk: { id: `l${i}`, kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: `Bash(pnpm lint --fix packages/p${i})`, detail: { command: `pnpm lint --fix packages/p${i}` } } });
    const a = await page.request.post(`/api/fleet/sessions/${id}/answer`, { headers: W, data: { askId: `l${i}`, decision: "allow" } });
    expect(a.ok()).toBeTruthy();
  }
  await report(page.request, { id, name: "Lint fixes", status: "running" });
  await page.goto("/app/policies");
  await expect(page.getByText("Prompts people keep approving")).toBeVisible();
  const row = page.locator("li", { hasText: "Bash(pnpm lint:*)" });
  await expect(row).toContainText("allowed here 5×");
  await row.getByRole("button", { name: "Always allow" }).click();
  await expect(page.getByText(/Bash\(pnpm lint:\*\) is allowed without asking/)).toBeVisible();
  const decide = await page.request.post("/api/ingest/decide", { headers: { authorization: `Bearer ${device}` }, data: { sessionId: id, tool: "Bash", command: "pnpm lint --fix apps/web" } });
  expect(await decide.json()).toMatchObject({ decision: "allow", explicit: true });
});
