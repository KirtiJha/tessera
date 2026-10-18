import { describe, expect, it } from "vitest";
import { buildRows, columnsFor } from "./wallLayout";

const items = (n: number, p = "s") => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}` }));

describe("columnsFor", () => {
  it("fits as many 330 px cards with 12 px gaps as the width holds, at least one", () => {
    expect(columnsFor(0)).toBe(1);
    expect(columnsFor(329)).toBe(1);
    expect(columnsFor(330)).toBe(1);
    expect(columnsFor(672)).toBe(2);
    expect(columnsFor(1014)).toBe(3);
    expect(columnsFor(1013)).toBe(2);
  });
});

describe("buildRows", () => {
  it("emits a header per group then rows of `cols` sessions", () => {
    const rows = buildRows([["waiting", items(2, "w")], ["running", items(7, "r")]], 3);
    expect(rows.map((r) => (r.kind === "header" ? `H:${r.group}:${r.count}` : `C:${r.items.length}`))).toEqual([
      "H:waiting:2", "C:2", "H:running:7", "C:3", "C:3", "C:1",
    ]);
  });
  it("keeps every session exactly once and keys stay unique", () => {
    const rows = buildRows([["a", items(500)]], 4);
    const ids = rows.flatMap((r) => (r.kind === "cards" ? r.items.map((i) => i.id) : []));
    expect(ids).toHaveLength(500);
    expect(new Set(ids).size).toBe(500);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
  it("treats zero columns as one", () => {
    expect(buildRows([["a", items(2)]], 0).filter((r) => r.kind === "cards")).toHaveLength(2);
  });
});
