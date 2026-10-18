import { devices, expect, test, type Page } from "@playwright/test";

/**
 * The console on a phone: the menu folds away, nothing is wider than the
 * screen, and a waiting prompt can be answered without hunting for it.
 */

const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices["Pixel 7"];
test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });

const run = `m${Date.now().toString(36)}`;
const sessionId = `e2e-${run}`;
const W = { "x-tessera-client": "web" };

/** Nothing on the page reaches past the right edge of the screen, scrollable tables aside. */
async function fitsTheScreen(page: Page) {
  const over = await page.evaluate(() => {
    const width = window.innerWidth;
    const out: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest(".overflow-x-auto, .overflow-auto")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > width + 2) out.push(`${el.tagName}.${String((el as HTMLElement).className).slice(0, 60)}`);
    }
    return out;
  });
  expect(over, "elements wider than the screen").toEqual([]);
}

test("the console works on a phone", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Organisation name").fill(`Mobile ${run}`);
  await page.getByLabel("Your name").fill("Pat Phone");
  await page.getByLabel("Work email").fill(`e2e-${run}@tessera-e2e.test`);
  await page.getByLabel("Password").fill("e2e-password-123");
  await page.getByRole("button", { name: "Create organisation" }).click();
  await page.waitForURL("**/app**");

  const device = (await (await page.request.post("/api/admin/devices", { headers: W, data: { label: "phone-test" } })).json()).token as string;
  const r = await page.request.post("/api/ingest/report", {
    headers: { authorization: `Bearer ${device}` },
    data: {
      v: 1,
      sentAt: new Date().toISOString(),
      reporter: { kind: "claude-code-hooks", version: "0.1.0" },
      machine: { hostname: "a-rather-long-laptop-hostname", machineId: "m" },
      session: {
        id: sessionId,
        name: "Refund retries for the payments service, with a long name",
        status: "waiting",
        startedAt: new Date(Date.now() - 300_000).toISOString(),
        model: "claude-sonnet-4-5",
        cwd: "/Users/someone/work/a-deeply/nested/payments-service",
        git: { repo: "acme/payments", branch: "feat/PAY-142-refund-retries-with-backoff" },
        waitReason: "permission",
        openAsk: { id: "ask-m", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(pnpm db:migrate --env staging)", options: [] },
      },
      events: [],
    },
  });
  expect(r.ok()).toBeTruthy();

  // The wall: the side menu is folded away and the session fits.
  await page.goto("/app");
  await expect(page.getByText("Refund retries for the payments").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Policies" })).toBeHidden();
  await fitsTheScreen(page);

  // The menu opens, navigates, and closes itself.
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Audit log" }).click();
  await page.waitForURL("**/app/audit");
  await expect(page.getByRole("dialog", { name: "Menu" })).toBeHidden();
  await fitsTheScreen(page);

  // The session page: the prompt and its buttons are on the first screen.
  await page.goto(`/app/sessions/${sessionId}`);
  const allow = page.getByRole("button", { name: "Allow once" });
  await expect(allow).toBeInViewport();
  await fitsTheScreen(page);
  await allow.click();
  await expect(page.getByText(/session will continue/i)).toBeVisible();

  for (const path of ["/app/analytics", "/app/people", "/app/policies", `/app/compare?a=${sessionId}`]) {
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
    await page.waitForTimeout(500);
    await fitsTheScreen(page);
  }
});
