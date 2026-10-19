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
  await expect(page.getByRole("button", { name: "Play replay" })).toBeVisible();
  // Space plays once the timeline has loaded; press again if the first press landed before that.
  await expect(async () => {
    if (await page.getByRole("button", { name: "Play replay" }).isVisible()) await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Pause replay" })).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 10_000 });

  await page.goto("/app/analytics");
  await expect(page.getByText("Estimated spend")).toBeVisible();

  await page.goto("/app/audit");
  await expect(page.getByText("session.answer.allow")).toBeVisible();
  await expect(page.getByText("policy.update")).toBeVisible();
  await page.getByRole("button", { name: "Verify chain" }).click();
  await expect(page.getByText(/Chain intact/)).toBeVisible();
});

test("the console remembers the theme and the navigation width, and leaves the landing page alone", async () => {
  await page.goto("/app");
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? "dark");
  const navWidth = () => page.locator('aside[aria-label="Main"]:visible').evaluate((el) => Math.round(el.getBoundingClientRect().width));
  expect(await theme()).toBe("dark");
  expect(await navWidth()).toBe(220);
  // Light, from the user menu.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("radio", { name: "Light" }).click();
  await expect.poll(theme).toBe("light");
  await page.keyboard.press("Escape");
  // The icon rail keeps every destination one click away, with its name on hover.
  await page.getByRole("button", { name: "Collapse navigation" }).click();
  await expect.poll(navWidth).toBe(60);
  await page.getByRole("link", { name: "History" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("History");
  // Both survive a reload: the theme is applied before React runs, so nothing flashes dark.
  await page.reload();
  await expect.poll(theme).toBe("light");
  await expect.poll(navWidth).toBe(60);
  // "System" follows the operating system.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("radio", { name: "System" }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(theme).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(theme).toBe("light");
  await page.keyboard.press("Escape");
  // The landing page paints light-on-paper by itself and never carries the console's theme.
  await page.goto("/");
  await expect.poll(theme).toBe("dark");
  // Back to the defaults from the Account page, for whoever reads this browser next.
  await page.goto("/app/settings");
  await page.getByRole("radio", { name: "Dark" }).click();
  await page.getByRole("radio", { name: "Expanded" }).click();
  await expect.poll(theme).toBe("dark");
  await expect.poll(navWidth).toBe(220);
});

test("the bell lists what needs a person, and ⌘K reaches a session, a page and a person", async () => {
  // A second session waits on a question; the bell counts it and opens to it.
  const waitingId = `${sessionId}-bell`;
  const r = await report(page.request, { id: waitingId, name: "Ledger reconciliation", status: "waiting", waitReason: "question", openAsk: { id: "q-bell", kind: "question", createdAt: new Date().toISOString(), tool: "AskUserQuestion", prompt: "Which ledger should be authoritative?", options: ["GL", "Sub-ledger"] } });
  expect(r.ok()).toBeTruthy();
  await page.goto("/app");
  const bell = page.getByRole("button", { name: /1 item needs attention/ });
  await expect(bell).toBeVisible();
  await bell.click();
  const menu = page.getByRole("menu", { name: /needs attention/ });
  await expect(menu).toContainText("Waiting on someone");
  await expect(menu).toContainText("Ledger reconciliation · Has a question");
  await expect(menu).toContainText("Which ledger should be authoritative?");
  await menu.getByRole("menuitem", { name: /Ledger reconciliation/ }).click();
  await page.waitForURL(`**/app/sessions/${waitingId}`);

  // ⌘K (Ctrl+K here) finds the live session by name and opens it on Enter.
  await page.goto("/app/history");
  await expect(page.getByRole("button", { name: "Open search" })).toBeVisible(); // the shell, and its key listener, are mounted
  await page.keyboard.press("Control+k");
  const box = page.getByRole("combobox", { name: "Search" });
  await expect(box).toBeFocused();
  await box.fill("ledger rec");
  const results = page.getByRole("listbox");
  await expect(results.getByRole("option", { name: /Ledger reconciliation/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.waitForURL(`**/app/sessions/${waitingId}`);

  // Pages and people are reachable the same way; a person lands on the wall filtered to them.
  await page.getByRole("button", { name: "Open search" }).click();
  await box.fill("audit");
  await expect(results.getByRole("option", { name: /Audit log/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(box).toBeHidden();
  await page.keyboard.press("Control+k");
  await box.fill("erin");
  await results.getByRole("option", { name: /^Erin Example/ }).click(); // the person, not the sessions she owns
  await page.waitForURL("**/app?q=Erin*");
  await expect(page.getByPlaceholder(/Filter by name/)).toHaveValue("Erin Example");
});

test("the wall works from the keyboard: move, allow, select, act on several at once", async () => {
  const permId = `${sessionId}-perm`;
  const r = await report(page.request, { id: permId, name: "Bulk approve me", status: "waiting", waitReason: "permission", openAsk: { id: "p-kbd", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "pnpm test", options: [], detail: { command: "pnpm test" } } });
  expect(r.ok()).toBeTruthy();
  await page.goto("/app");
  await expect(page.getByRole("button", { name: "Open search" })).toBeVisible();
  await expect(page.getByText("Bulk approve me")).toBeVisible();
  // j focuses the first card: the newest waiting session.
  await page.keyboard.press("j");
  const focused = page.locator('a[aria-current="true"]');
  await expect(focused).toHaveCount(1);
  await expect(focused).toContainText("Bulk approve me");
  // a answers the permission prompt from the card, which shows the command and its risk.
  await page.keyboard.press("a");
  await expect(page.getByText(/Bulk approve me: allowed once/)).toBeVisible();
  // x selects; the bar offers the rest; Pause applies to every selected session.
  await page.keyboard.press("x");
  const bar = page.getByRole("toolbar", { name: "Selected sessions" });
  await expect(bar).toContainText("1 selected");
  await bar.getByRole("button", { name: /Select all \d+ shown/ }).click();
  await expect(bar).toContainText(/[2-9] selected/);
  await bar.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText(/Paused \d+ sessions?\./)).toBeVisible();
  await expect(bar).toBeHidden();
  // ? explains the keys; / jumps to the filter box.
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
  await page.keyboard.press("/");
  await expect(page.getByPlaceholder(/Filter by name/)).toBeFocused();
});
