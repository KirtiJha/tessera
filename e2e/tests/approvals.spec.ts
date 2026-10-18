import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Informed approvals: an approver sees the actual change, the risk, the
 * agent's reason and the steps before the prompt; can allow a pattern for the
 * rest of the session; and can answer a multiple-choice question.
 */

const run = `a${Date.now().toString(36)}`;
const W = { "x-tessera-client": "web" };
let device = "";

const report = (request: APIRequestContext, session: Record<string, unknown>) =>
  request.post("/api/ingest/report", {
    headers: { authorization: `Bearer ${device}` },
    data: {
      v: 1,
      sentAt: new Date().toISOString(),
      reporter: { kind: "claude-code-hooks", version: "0.1.0" },
      machine: { hostname: "e2e-laptop", machineId: "e2e-machine" },
      session: { startedAt: new Date(Date.now() - 120_000).toISOString(), model: "claude-sonnet-4-5", cwd: "/work/payments", git: { repo: "acme/payments", branch: "feat/refunds" }, ...session },
      events: [],
    },
  });
const deliveries = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`/api/ingest/sessions/${id}/deliveries`, { headers: { authorization: `Bearer ${device}` } })).json()).deliveries as { kind: string; askId: string; payload: Record<string, unknown> }[];

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  // A fresh context: the signed-in state is what this hook produces.
  const page = await browser.newPage({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4700", storageState: { cookies: [], origins: [] } });
  await page.goto("/signup");
  await page.getByLabel("Organisation name").fill(`Approvals ${run}`);
  await page.getByLabel("Your name").fill("Ava Approver");
  await page.getByLabel("Work email").fill(`e2e-${run}@tessera-e2e.test`);
  await page.getByLabel("Password").fill("e2e-password-123");
  await page.getByRole("button", { name: "Create organisation" }).click();
  await page.waitForURL("**/app**");
  device = (await (await page.request.post("/api/admin/devices", { headers: W, data: { label: "e2e-laptop" } })).json()).token;
  await page.context().storageState({ path: `/tmp/e2e-${run}.json` });
  await page.close();
});

test.use({ storageState: async ({}, use) => use(`/tmp/e2e-${run}.json`) });

test("an edit is shown as a diff, with the agent's reason and what led here", async ({ page }) => {
  const id = `${run}-edit`;
  await report(page.request, {
    id, name: "Refund retries", status: "waiting", waitReason: "permission",
    activity: [
      { id: "t1", ts: new Date(Date.now() - 60_000).toISOString(), tool: "Bash", summary: "Bash(pnpm test --filter refunds)", status: "failed", endedAt: new Date(Date.now() - 30_000).toISOString(), durationMs: 30_000, error: "2 tests failed" },
      { id: "t2", ts: new Date(Date.now() - 20_000).toISOString(), tool: "Read", summary: "Read(/work/payments/src/client.ts)", status: "ok", endedAt: new Date(Date.now() - 19_000).toISOString(), durationMs: 12 },
    ],
    openAsk: {
      id: "ask-edit", kind: "permission", createdAt: new Date().toISOString(), tool: "Edit", prompt: "Edit(/work/payments/src/client.ts)",
      detail: { edits: [{ path: "/work/payments/src/client.ts", before: "const retries = 0;\nexport {};", after: "const retries = 3;\nexport {};", replaceAll: false }], rationale: "Refunds need retries on 5xx.", paths: ["/work/payments/src/client.ts"] },
    },
  });
  await page.goto(`/app/sessions/${id}`);
  await expect(page.getByText("− const retries = 0;".replace("− ", ""), { exact: false }).first()).toBeVisible();
  await expect(page.getByText("const retries = 3;")).toBeVisible();
  await expect(page.getByText("Refunds need retries on 5xx.")).toBeVisible();
  await expect(page.getByText("What led here")).toBeVisible();
  await expect(page.getByText("2 tests failed").first()).toBeVisible();
  // An edit has no pattern worth remembering as a command, but its folder is offered.
  await page.getByRole("button", { name: "More ways to allow" }).click();
  await expect(page.getByText("Edit(/work/payments/src/**)")).toBeVisible();
});

test("a risky command is flagged on the wall and can be allowed for the rest of the session", async ({ page }) => {
  const id = `${run}-cmd`;
  await report(page.request, {
    id, name: "Staging peering", status: "waiting", waitReason: "permission", cwd: "/work/infra",
    openAsk: {
      id: "ask-cmd", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(terraform apply -target=module.peering)",
      detail: { command: "terraform apply -target=module.peering -auto-approve", description: "Apply the peering module", rationale: "No destroys in the plan.", forcedBy: "Infra changes need a human look.", suggestedRules: [{ tool: "Bash", content: "terraform apply:*" }] },
    },
  });
  await page.goto("/app");
  const card = page.locator("a", { hasText: "Staging peering" }).first();
  await expect(card.getByText("Changes infrastructure")).toBeVisible();
  await card.click();
  await page.waitForURL(`**/app/sessions/${id}`);
  await expect(page.getByText("Asked because of policy: Infra changes need a human look.")).toBeVisible();
  await expect(page.getByText("terraform apply -target=module.peering -auto-approve")).toBeVisible();
  await page.getByRole("button", { name: "More ways to allow" }).click();
  await page.getByText("Allow for the rest of this session").click();
  await expect(page.getByText(/is allowed until the session ends/)).toBeVisible();
  const d = await deliveries(page.request, id);
  expect(d).toEqual([expect.objectContaining({ kind: "answer", askId: "ask-cmd", payload: expect.objectContaining({ decision: "allow", scope: "session", rule: { tool: "Bash", content: "terraform apply:*" } }) })]);
});

test("a multiple-choice question is answered with one tap", async ({ page }) => {
  const id = `${run}-q`;
  await report(page.request, {
    id, name: "Driver upgrade", status: "waiting", waitReason: "question",
    openAsk: {
      id: "ask-q", kind: "question", createdAt: new Date().toISOString(), tool: "AskUserQuestion", prompt: "Which way?",
      detail: { questions: [{ question: "Which way should I go?", header: "Approach", options: [{ label: "Pin to 9.1", description: "Cleanest" }, { label: "Stay on v8" }], multiSelect: false }] },
    },
  });
  await page.goto(`/app/sessions/${id}`);
  await page.getByRole("button", { name: /Pin to 9\.1/ }).click();
  await expect(page.getByText(/session will continue/)).toBeVisible();
  const d = await deliveries(page.request, id);
  expect(d[0]!.payload).toEqual(expect.objectContaining({ decision: "answer", option: "Pin to 9.1", answers: { "Which way should I go?": "Pin to 9.1" } }));
});

test("a running session shows what it is doing now", async ({ page }) => {
  const id = `${run}-run`;
  await report(page.request, {
    id, name: "Redaction audit", status: "running",
    activity: [{ id: "t9", ts: new Date().toISOString(), tool: "Bash", summary: "Bash(pnpm lint)", status: "running" }],
  });
  await page.goto("/app");
  const card = page.locator("a", { hasText: "Redaction audit" }).first();
  await expect(card.getByText("Bash(pnpm lint)")).toBeVisible();
});
