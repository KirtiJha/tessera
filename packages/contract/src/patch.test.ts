import { describe, expect, it } from "vitest";
import { unifiedPatch } from "./patch.js";

describe("unifiedPatch", () => {
  it("shows a changed line in the middle of a file with its context and numbers", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h"].join("\n");
    const p = unifiedPatch(before, after);
    expect(p).toMatchObject({ added: 1, removed: 1, truncated: false });
    expect(p.patch).toBe(["@@ -2,7 +2,7 @@", " b", " c", " d", "-e", "+E", " f", " g", " h"].join("\n"));
  });
  it("numbers an Edit from where its text starts in the file", () => {
    expect(unifiedPatch("x = 1\n", "x = 2\ny = 3\n", 40).patch).toBe(["@@ -40,1 +40,2 @@", "-x = 1", "+x = 2", "+y = 3"].join("\n"));
  });
  it("shows a new file as all additions, and two far-apart changes as two hunks", () => {
    expect(unifiedPatch("", "one\ntwo\n").patch).toBe("@@ -0,0 +1,2 @@\n+one\n+two");
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const changed = lines.map((l, i) => (i === 2 || i === 25 ? `${l}!` : l));
    expect(unifiedPatch(lines.join("\n"), changed.join("\n")).patch.match(/^@@/gm)).toHaveLength(2);
  });
});
