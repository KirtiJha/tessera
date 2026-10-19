import { describe, expect, it } from "vitest";
import { parseReport, priceUsage, redact, findPrice } from "./index.js";

const base = {
  v: 1,
  sentAt: new Date().toISOString(),
  reporter: { kind: "claude-code-hooks", version: "0.1.0" },
  machine: { hostname: "dev-box", machineId: "abc123" },
  session: {
    id: "s1",
    status: "running",
    startedAt: new Date().toISOString(),
  },
  events: [],
};

describe("parseReport", () => {
  it("accepts a minimal report and fills defaults", () => {
    const r = parseReport(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.session.tokens.input).toBe(0);
      expect(r.report.session.agents).toEqual([]);
      expect(r.report.reporter.schema).toBe("1.0");
    }
  });
  it("rejects a bad status with a readable path", () => {
    const r = parseReport({ ...base, session: { ...base.session, status: "flying" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("session.status");
  });
});

describe("pricing", () => {
  it("matches the longest prefix", () => {
    expect(findPrice("claude-sonnet-4-5-20250929")?.label).toBe("Claude Sonnet 4.5");
    expect(findPrice("claude-opus-4-1")?.label).toBe("Claude Opus 4.1");
    expect(findPrice("gemma4:12b")).toBeNull();
    // The longest prefix wins, so a generation does not swallow its point release.
    expect(findPrice("claude-opus-5-5")?.label).toBe("Claude Opus 5.5");
    expect(findPrice("claude-opus-5")?.label).toBe("Claude Opus 5");
    expect(findPrice("claude-sonnet-5-5-20260601")?.input).toBe(2);
    expect(findPrice("claude-fable-5-1")?.cacheRead).toBe(0.25);
    expect(findPrice("claude-haiku-5-5")?.output).toBe(0.5);
    // Bedrock and Vertex ids carry the same model under a platform prefix or suffix.
    expect(findPrice("us.anthropic.claude-sonnet-4-5-20250929-v1:0")?.label).toBe("Claude Sonnet 4.5");
    expect(findPrice("claude-opus-4-8@20260301")?.label).toBe("Claude Opus 4.8");
  });
  it("prices tokens and reports unpriced models", () => {
    const r = priceUsage([
      { model: "claude-haiku-4-5", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      { model: "local-llama", input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
    ]);
    expect(r.usd).toBeCloseTo(1, 6);
    expect(r.unpriced).toEqual(["local-llama"]);
  });
});

describe("redact", () => {
  it("masks known key shapes and assignments", () => {
    expect(redact("key sk-ant-api03-abcdefghijklmnop")).toBe("key [redacted]");
    expect(redact("password=hunter2secret")).toBe("password=[redacted]");
    expect(redact("AKIAABCDEFGHIJKLMNOP in config")).toBe("[redacted] in config");
  });
  it("masks high-entropy tokens but keeps uuids and words", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(redact(`id ${uuid}`)).toBe(`id ${uuid}`);
    expect(redact("x9K2mP4qL8nR7vT1wZ5yB3cD6fG0hJ4k")).toBe("[redacted]");
    expect(redact("thisisjustaverylongordinarylowercaseword")).toContain("ordinary");
    const path = "/tmp/claude-0/-home-claude/f6f99f43-73a4-5c7d-b3ee-27af75e49e90/scratchpad/repo";
    expect(redact(path)).toBe(path);
    expect(redact("git sha 3f2a9c1e5b7d4e8a9c217d4e5f6a8b90c0ffee12 ok")).toContain("3f2a9c1e5b7d");
  });
});

describe("data-loss prevention", async () => {
  const { applyDlp } = await import("./redact.js");
  const all = { emails: true, cards: true, nationalIds: true, ibans: true, terms: ["Project Falcon", "ACME-Bank"] };
  it("removes the classes the organisation turned on, and only real ones", () => {
    expect(applyDlp("mail ann.lee@example.co.uk now", all)).toBe("mail [email] now");
    expect(applyDlp("card 4111 1111 1111 1111 and order 4111 1111 1111 1112", all)).toBe("card [card] and order 4111 1111 1111 1112");
    expect(applyDlp("ssn 123-45-6789, not 000-12-3456", all)).toBe("ssn [id-number], not 000-12-3456");
    expect(applyDlp("pay GB82 WEST 1234 5698 7654 32 or GB00 WEST 1234 5698 7654 32", all)).toBe("pay [iban] or GB00 WEST 1234 5698 7654 32");
    expect(applyDlp("deploy project falcon to acme-bank (a.b) prod", all)).toBe("deploy [term] to [term] (a.b) prod");
    expect(applyDlp("ann@example.com 4111111111111111", { emails: false, cards: false, nationalIds: false, ibans: false, terms: [] })).toBe("ann@example.com 4111111111111111");
  });
});
