import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "tessera-diff-home-"));
process.env.TESSERA_HOME = home;
const { collectDiff } = await import("./diff.js");
const { heartbeat } = await import("./hooks.js");
const { updateState } = await import("./state.js");

const repo = mkdtempSync(join(tmpdir(), "tessera-diff-repo-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
git("init", "-q");
git("config", "user.email", "t@example.test");
git("config", "user.name", "T");
writeFileSync(join(repo, "app.ts"), "export const a = 1;\nexport const b = 2;\n");
writeFileSync(join(repo, "big.txt"), "x\n");
git("add", ".");
git("commit", "-qm", "init");

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("collectDiff", () => {
  it("sends each changed file's diff against HEAD, a new file as all additions, and redacts secrets", () => {
    writeFileSync(join(repo, "app.ts"), "export const a = 1;\nexport const b = 3;\nconst key = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';\n");
    writeFileSync(join(repo, "new.md"), "# Notes\nhello\n");
    const d = collectDiff(repo, "req-1", true);
    expect(d.error).toBeNull();
    const app = d.files.find((f) => f.path === "app.ts")!;
    expect(app.status).toBe("modified");
    expect(app.diff).toContain("-export const b = 2;");
    expect(app.diff).toContain("+export const b = 3;");
    expect(app.diff).not.toContain("sk-ant-api03-AbCdEf");
    const added = d.files.find((f) => f.path === "new.md")!;
    expect(added).toMatchObject({ status: "untracked", binary: false });
    expect(added.diff).toContain("@@ -0,0 +1,2 @@\n+# Notes\n+hello");
  });

  it("cuts a very large file's diff and says so", () => {
    writeFileSync(join(repo, "big.txt"), "line of text that is long enough\n".repeat(2000));
    const big = collectDiff(repo, "req-2", true).files.find((f) => f.path === "big.txt")!;
    expect(big.truncated).toBe(true);
    expect(big.diff.length).toBe(20_000);
  });

  it("refuses on a machine set to send no excerpts, and outside a git repository", () => {
    expect(collectDiff(repo, "r", false)).toMatchObject({ files: [], error: expect.stringContaining("no excerpts") });
    expect(collectDiff(home, "r", true)).toMatchObject({ files: [], error: expect.stringContaining("not a git repository") });
  });
});

describe("the keep-alive", () => {
  it("takes a diff request with its report and sends the diff, leaving answers and messages queued", async () => {
    const posted: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      posted.push({ path, body });
      const deliveries = path === "/api/ingest/report" ? [{ id: "c-1", kind: "command", askId: null, payload: { op: "diff", requestId: "req-9" } }] : [];
      const reply = path === "/api/ingest/report" ? { ok: true, serverTime: new Date().toISOString(), sessionId: "ka", ackedEvents: [], liveSessions: 1, deliveries, reporterSupport: "ok" } : { ok: true };
      return Promise.resolve(new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } }));
    });
    updateState("ka", repo, null, (s) => void (s.status = "waiting"));
    const cfg = { serverUrl: "http://tessera.test", token: "t", label: "l", machineId: "m", excerpts: true, permissionWaitSeconds: 1, questionWaitSeconds: 1 };
    expect(await heartbeat(cfg, "ka")).toBe(true);
    expect(posted[0]!.body.claimKinds).toEqual(["command"]);
    const diff = posted.find((p) => p.path === "/api/ingest/sessions/ka/diff")!;
    expect(diff.body.requestId).toBe("req-9");
    expect((diff.body.files as { path: string }[]).map((f) => f.path)).toContain("app.ts");
    expect(posted.find((p) => p.path === "/api/ingest/deliveries/c-1/result")?.body).toMatchObject({ result: { applied: true } });
  });
});
