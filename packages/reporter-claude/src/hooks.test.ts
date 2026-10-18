import { describe, expect, it } from "vitest";
import { decideRequest } from "./hooks.js";

describe("decideRequest", () => {
  it("sends the command, every path and the URL, redacted", () => {
    expect(decideRequest("s1", "Bash", { command: "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' https://x" })).toEqual({
      sessionId: "s1",
      tool: "Bash",
      command: expect.not.stringContaining("sk-ant-api03"),
    });
    expect(decideRequest("s1", "MultiEdit", { file_path: "/r/a.ts", edits: [{ file_path: "/r/a.ts" }, { file_path: "/r/b.ts" }] }).paths).toEqual(["/r/a.ts", "/r/b.ts"]);
    expect(decideRequest("s1", "WebFetch", { url: "https://intranet.example.com/x", prompt: "summarise" })).toEqual({ sessionId: "s1", tool: "WebFetch", url: "https://intranet.example.com/x" });
    expect(decideRequest("s1", "Task", { description: "explore" })).toEqual({ sessionId: "s1", tool: "Task" });
  });
});
