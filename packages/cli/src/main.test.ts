import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve, run } from "./main.js";
import { parseArgs, table } from "./util.js";

const sessions = [
  { id: "a1b2c3d4-0000", name: "Refactor billing", ownerName: "Riya", status: "waiting", stale: false, waitReason: "permission", model: "claude-sonnet-4-5", startedAt: new Date().toISOString(), costUsd: 1.5, cwd: "/r", git: null, openAsk: { id: "ask-1", kind: "permission", tool: "Bash", prompt: "Bash(terraform apply)", options: [], createdAt: new Date().toISOString() }, assignee: null, stopRequested: false, tags: {} },
  { id: "a1ffee00-1111", name: "Docs", ownerName: "Sam", status: "running", stale: false, waitReason: null, model: "claude-haiku-4-5", startedAt: new Date().toISOString(), costUsd: 0.1, cwd: "/d", git: null, openAsk: null, assignee: null, stopRequested: false, tags: {} },
];
const seen: { method: string; url: string; body: unknown; auth: string | undefined }[] = [];
let policy = { version: 3, rules: [{ id: "env", name: "No secrets", effect: "deny", match: { tools: ["Read"] } }] };
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    seen.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : undefined, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer tsk_test") return res.writeHead(401).end(JSON.stringify({ error: "API key missing, revoked, expired, or its owner is disabled" }));
    if (req.url === "/api/v1/fleet/state") return res.end(JSON.stringify({ sessions }));
    if (req.url === "/api/v1/admin/policy" && req.method === "GET") return res.end(JSON.stringify(policy));
    if (req.url === "/api/v1/admin/policy" && req.method === "PUT") {
      const b = JSON.parse(raw);
      if (b.baseVersion !== policy.version) return res.writeHead(409).end(JSON.stringify({ error: "changed" }));
      policy = { version: policy.version + 1, rules: b.rules };
      return res.end(JSON.stringify({ ok: true, version: policy.version }));
    }
    if (req.url?.includes("/stop")) return res.writeHead(403).end(JSON.stringify({ error: "This API key lacks the sessions:act scope" }));
    return res.end(JSON.stringify({ ok: true }));
  });
});

let outText = "";
let errText = "";
async function cli(...argv: string[]): Promise<number> {
  outText = "";
  errText = "";
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => ((outText += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((errText += s), true)) as typeof process.stderr.write;
  try {
    return await run(argv);
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.TESSERA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.TESSERA_API_KEY = "tsk_test";
  process.env.NO_COLOR = "1";
});
afterAll(() => server.close());

describe("cli", () => {
  it("parses flags and positionals", () => {
    expect(parseArgs(["deny", "abc", "--reason", "too risky", "--dry-run", "-o", "x.json", "--by=team"], ["dry-run"])).toEqual({ _: ["deny", "abc"], flags: { reason: "too risky", "dry-run": true, o: "x.json", by: "team" } });
  });
  it("prints its version", async () => {
    expect(await cli("--version")).toBe(0);
    expect(outText).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
  it("aligns tables", () => {
    expect(table(["A", "BB"], [["xxx", "1"], ["y", "22"]], [1])).toBe("A    BB\nxxx   1\ny    22");
  });
  it("resolves sessions by id, prefix or name, and refuses ambiguity", () => {
    expect(resolve(sessions, "a1b2").id).toBe("a1b2c3d4-0000");
    expect(resolve(sessions, "docs").id).toBe("a1ffee00-1111");
    expect(() => resolve(sessions, "a1")).toThrow(/matches 2 sessions/);
    expect(() => resolve(sessions, "nope")).toThrow(/no live session/);
  });
  it("lists live sessions with the waiting one first", async () => {
    expect(await cli("sessions")).toBe(0);
    const lines = outText.trim().split("\n");
    expect(lines[0]).toMatch(/^ID\s+SESSION\s+PERSON\s+STATE/);
    expect(lines[1]).toContain("Refactor billing");
    expect(lines[1]).toContain("waiting · permission");
  });
  it("allows the open prompt of a session named by prefix", async () => {
    expect(await cli("allow", "a1b2")).toBe(0);
    const call = seen.at(-1)!;
    expect(call).toMatchObject({ method: "POST", url: "/api/v1/fleet/sessions/a1b2c3d4-0000/answer", body: { askId: "ask-1", decision: "allow" }, auth: "Bearer tsk_test" });
    expect(outText).toContain("allowed Bash in Refactor billing");
    expect(await cli("approve", "a1b2")).toBe(1);
    expect(errText).toContain("waiting on a permission, not a plan");
  });
  it("applies a policy file with a diff, and is a no-op when nothing changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-cli-"));
    const file = join(dir, "policy.json");
    writeFileSync(file, JSON.stringify({ rules: [...policy.rules, { id: "tf", name: "Terraform", effect: "ask", match: { commands: ["terraform *"] } }] }));
    expect(await cli("policy", "apply", file, "--dry-run")).toBe(0);
    expect(outText).toContain("+1");
    expect(policy.version).toBe(3);
    expect(await cli("policy", "apply", file, "--note", "add terraform")).toBe(0);
    expect(seen.at(-1)).toMatchObject({ method: "PUT", body: { baseVersion: 3, note: "add terraform" } });
    expect(outText).toContain("version 4 is in force");
    expect(await cli("policy", "apply", file)).toBe(0);
    expect(outText).toContain("no change");
  });
  it("reports the server's refusal and a bad key plainly", async () => {
    expect(await cli("stop", "docs")).toBe(1);
    expect(errText).toBe("tessera: This API key lacks the sessions:act scope\n");
    process.env.TESSERA_API_KEY = "tsk_wrong";
    expect(await cli("sessions")).toBe(1);
    expect(errText).toContain("run `tessera login` again");
    process.env.TESSERA_API_KEY = "tsk_test";
  });
});
