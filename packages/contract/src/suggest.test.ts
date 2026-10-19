import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "./policy.js";
import { parsePrompt, ruleFromSuggestion, suggestRules, type PastAsk } from "./suggest.js";

const ask = (prompt: string, decision: string | null, person = "ann", at = "2026-10-19T10:00:00.000Z"): PastAsk => ({ prompt, decision, person, at });

describe("suggestRules", () => {
  it("suggests a command asked about often and never denied, and counts who approved it", () => {
    const asks = [
      ...Array.from({ length: 4 }, (_, i) => ask(`Bash(pnpm test --filter pkg${i})`, "allow", i % 2 ? "ann" : "bob")),
      ask("Bash(pnpm test)", null),
      ask("Bash(ls -la)", "allow"),
    ];
    const s = suggestRules(asks, { rules: [] });
    expect(s).toEqual([expect.objectContaining({ key: "Bash(pnpm test:*)", tool: "Bash", content: "pnpm test:*", asked: 5, allowedHere: 4, people: 2 })]);
  });

  it("never suggests something denied, something risky, or something a rule already decides", () => {
    const many = (p: string, d: string | null = "allow") => Array.from({ length: 6 }, () => ask(p, d));
    const asks = [...many("Bash(git push origin feature)"), ask("Bash(git push origin main)", "deny"), ...many("Bash(rm -rf build)"), ...many("Bash(terraform plan)")];
    const doc = { rules: [{ id: "tf", name: "Ask before terraform", effect: "ask" as const, mode: "enforce" as const, enabled: true, reason: "", match: { tools: ["Bash"], commands: ["terraform *"], paths: [], urls: [], models: [], repos: [], branches: [], teams: [] } }] };
    expect(suggestRules(asks, doc)).toEqual([]);
  });

  it("parses the prompt forms reporters send", () => {
    expect(parsePrompt("Bash(echo (nested) ok)")).toEqual({ tool: "Bash", arg: "echo (nested) ok" });
    expect(parsePrompt("WebSearch")).toEqual({ tool: "WebSearch", arg: null });
    expect(parsePrompt("not a prompt!")).toBeNull();
  });
});

describe("ruleFromSuggestion", () => {
  it("matches the command and its arguments, but not a longer program name", () => {
    const rule = ruleFromSuggestion({ tool: "Bash", content: "pnpm test:*" }, "s1");
    const doc = { rules: [rule] };
    expect(evaluatePolicy(doc, { tool: "Bash", command: "pnpm test" }).decision).toBe("allow");
    expect(evaluatePolicy(doc, { tool: "Bash", command: "pnpm test --filter x" }).rule?.id).toBe("s1");
    expect(evaluatePolicy(doc, { tool: "Bash", command: "pnpm testing" }).rule).toBeNull();
    expect(evaluatePolicy(doc, { tool: "Read", command: "pnpm test" }).rule).toBeNull();
  });
  it("turns folders and domains into paths and URLs", () => {
    expect(ruleFromSuggestion({ tool: "Edit", content: "/r/src/**" }, "e").match.paths).toEqual(["/r/src/**"]);
    expect(ruleFromSuggestion({ tool: "WebFetch", content: "domain:docs.example.com" }, "w").match.urls).toEqual(["https://docs.example.com", "https://docs.example.com/**"]);
  });
});
