import { describe, expect, it } from "vitest";
import { samePath, touchedBy } from "./agentFocus";

describe("touchedBy", () => {
  const touched = [
    { path: "/w/repo/src/a.ts", agentId: "ag-1", edits: 2, lastAt: "" },
    { path: "/w/repo/src/a.ts", agentId: null, edits: 1, lastAt: "" },
    { path: "/w/repo/src/b.ts", agentId: "ag-2", edits: 1, lastAt: "" },
  ];

  it("finds every agent that edited a file git reports relative to the repository", () => {
    expect(touchedBy(touched, "src/a.ts")).toEqual(["ag-1", null]);
    expect(touchedBy(touched, "src/b.ts")).toEqual(["ag-2"]);
  });

  it("does not take a file for another that only ends with the same name", () => {
    expect(touchedBy(touched, "a.ts")).toEqual(["ag-1", null]);
    expect(touchedBy(touched, "rc/a.ts")).toEqual([]);
    expect(samePath("/w/repo/xsrc/a.ts", "src/a.ts")).toBe(false);
  });
});
