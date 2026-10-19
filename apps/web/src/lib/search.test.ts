import { describe, expect, it } from "vitest";
import { rank, score } from "./search";

describe("score", () => {
  it("prefers a field that starts with the query over a word start over a substring", () => {
    expect(score("ref", ["refunds"])).toBe(3);
    expect(score("ref", ["acme/refunds"])).toBe(2);
    expect(score("fun", ["refunds"])).toBe(1);
    expect(score("xyz", ["refunds"])).toBe(0);
  });
  it("is an exact match above everything, case-insensitively", () => {
    expect(score("Live Wall", ["live wall"])).toBe(4);
  });
  it("matches everything on an empty query", () => {
    expect(score("  ", [null, "anything"])).toBe(1);
  });
  it("skips empty fields", () => {
    expect(score("a", [null, undefined, ""])).toBe(0);
  });
});

describe("rank", () => {
  const items = [
    { name: "acme/payments", branch: "feat/refunds" },
    { name: "refund-service", branch: "main" },
    { name: "billing", branch: "fix/refund-rounding" },
    { name: "docs", branch: "main" },
  ];
  it("orders by match quality and keeps original order on ties", () => {
    expect(rank("refund", items, (i) => [i.name, i.branch]).map((i) => i.name)).toEqual(["refund-service", "acme/payments", "billing"]);
  });
  it("drops non-matches and respects the limit", () => {
    expect(rank("main", items, (i) => [i.branch], 1).map((i) => i.name)).toEqual(["refund-service"]);
  });
});
