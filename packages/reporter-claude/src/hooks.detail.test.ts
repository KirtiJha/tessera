import { describe, expect, it } from "vitest";
import { askDetail, sessionRule } from "./hooks.js";

describe("askDetail", () => {
  it("carries the whole command and its description, redacted", () => {
    const d = askDetail("Bash", { command: "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' https://x", description: "Call the API" }, undefined, "I will check the API", null);
    expect(d.command).toContain("[redacted]");
    expect(d.command).not.toContain("sk-ant-api03");
    expect(d.description).toBe("Call the API");
    expect(d.rationale).toBe("I will check the API");
    expect(d.edits).toEqual([]);
  });

  it("shows an edit as before and after, and a write as an excerpt with its size", () => {
    const e = askDetail("Edit", { file_path: "/r/a.ts", old_string: "const a = 1;", new_string: "const a = 2;", replace_all: true }, undefined, null, null);
    expect(e.edits).toEqual([{ path: "/r/a.ts", before: "const a = 1;", after: "const a = 2;", replaceAll: true }]);
    expect(e.paths).toEqual(["/r/a.ts"]);
    const w = askDetail("Write", { file_path: "/r/b.txt", content: "line1\nline2\n" }, undefined, null, null);
    expect(w.write).toEqual({ path: "/r/b.txt", excerpt: "line1\nline2\n", lines: 3, bytes: 12 });
    const m = askDetail("MultiEdit", { file_path: "/r/c.ts", edits: [{ old_string: "x", new_string: "y" }, { file_path: "/r/d.ts", old_string: "p", new_string: "q" }] }, undefined, null, null);
    expect(m.edits.map((x) => x.path)).toEqual(["/r/c.ts", "/r/d.ts"]);
    expect(m.paths).toEqual(["/r/c.ts", "/r/d.ts"]);
  });

  it("keeps the runtime's allow suggestions and the policy reason", () => {
    const d = askDetail("Bash", { command: "pnpm test" }, [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "pnpm test:*" }], behavior: "allow", destination: "localSettings" }, { type: "setMode", mode: "auto", destination: "session" }], null, "Infra changes need a human look.");
    expect(d.suggestedRules).toEqual([{ tool: "Bash", content: "pnpm test:*" }]);
    expect(d.forcedBy).toBe("Infra changes need a human look.");
  });

  it("carries multiple-choice questions", () => {
    const d = askDetail("AskUserQuestion", { questions: [{ question: "Which framework?", header: "Framework", options: [{ label: "React", description: "Component library" }, { label: "Vue" }], multiSelect: false }] }, undefined, null, null);
    expect(d.questions).toEqual([{ question: "Which framework?", header: "Framework", options: [{ label: "React", description: "Component library" }, { label: "Vue", description: null }], multiSelect: false }]);
  });
});

describe("sessionRule", () => {
  it("turns an approver's rule into a session-scoped allow update", () => {
    expect(sessionRule({ tool: "Bash", content: "pnpm test:*" })).toEqual({ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "pnpm test:*" }], behavior: "allow", destination: "session" });
    expect(sessionRule({ tool: "WebSearch" })).toEqual({ type: "addRules", rules: [{ toolName: "WebSearch" }], behavior: "allow", destination: "session" });
    expect(sessionRule(null)).toBeNull();
    expect(sessionRule({ content: "x" })).toBeNull();
  });
});
