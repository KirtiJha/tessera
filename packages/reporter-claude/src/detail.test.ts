import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { callDetail, outputDetail } from "./detail.js";

const dir = mkdtempSync(join(tmpdir(), "tessera-detail-"));
const file = join(dir, "netmap.py");
writeFileSync(file, ["import re", "", "def ports():", "    return [22, 80]", "", "def hosts():", "    return []"].join("\n") + "\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("what a tool call records", () => {
  it("an edit's lines added and removed always, and its patch numbered where it lands only when edits are kept", () => {
    const input = { file_path: file, old_string: "    return [22, 80]", new_string: "    return [22, 80, 443]\n    # tls" };
    expect(callDetail("Edit", input, dir, false)).toEqual({ path: file, added: 2, removed: 1 });
    const kept = callDetail("Edit", input, dir, true)!;
    expect(kept.patch).toBe(["@@ -4,1 +4,2 @@", "-    return [22, 80]", "+    return [22, 80, 443]", "+    # tls"].join("\n"));
  });

  it("a write against the file it replaces, and a command whole, with secrets redacted", () => {
    const w = callDetail("Write", { file_path: file, content: "import re\n" }, dir, true)!;
    expect(w).toMatchObject({ added: 0, removed: 6 });
    const b = callDetail("Bash", { command: "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' https://x", description: "Call the API" }, dir, true)!;
    expect(b.description).toBe("Call the API");
    expect(b.command).not.toContain("sk-ant-api03");
  });

  it("a command's last lines, stdout then stderr, and whether it was interrupted", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const o = outputDetail("Bash", { stdout: lines, stderr: "warning: slow", interrupted: true });
    expect(o.interrupted).toBe(true);
    expect(o.output).toMatchObject({ lines: 61, truncated: true });
    expect(o.output!.tail.split("\n")).toHaveLength(40);
    expect(o.output!.tail.endsWith("line 59\nwarning: slow")).toBe(true);
    expect(outputDetail("Read", { file: { content: "secret code" } })).toEqual({});
  });
});
