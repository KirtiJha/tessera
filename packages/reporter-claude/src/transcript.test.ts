import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { advance, contextFill, newCursor, usageList } from "./transcript.js";

const line = (o: unknown) => JSON.stringify(o) + "\n";

describe("transcript", () => {
  it("accumulates usage per model incrementally and tracks context", () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(p, line({ type: "user", message: { role: "user", content: "Fix the bug" } }) + line({ type: "assistant", message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } }));
    let cur = advance(p, newCursor());
    expect(cur.tokens).toEqual({ input: 100, output: 10, cacheRead: 1000, cacheWrite: 0 });
    expect(cur.firstUserText).toBe("Fix the bug");
    expect(contextFill(cur)).toEqual({ used: 1110, window: 200_000 });
    appendFileSync(p, line({ type: "assistant", message: { role: "assistant", model: "claude-haiku-4-5", content: "x", usage: { input_tokens: 5, output_tokens: 5 } } }));
    cur = advance(p, cur);
    expect(cur.tokens.input).toBe(105);
    expect(usageList(cur).map((u) => u.model).sort()).toEqual(["claude-haiku-4-5", "claude-sonnet-4-5"]);
    expect(cur.model).toBe("claude-haiku-4-5");
  });
  it("handles a partial trailing line across reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-"));
    const p = join(dir, "t.jsonl");
    const full = line({ type: "assistant", message: { role: "assistant", model: "m", usage: { input_tokens: 7, output_tokens: 1 } } });
    writeFileSync(p, full.slice(0, 20));
    let cur = advance(p, newCursor());
    expect(cur.tokens.input).toBe(0);
    appendFileSync(p, full.slice(20));
    cur = advance(p, cur);
    expect(cur.tokens.input).toBe(7);
  });
  it("restarts when the file shrinks (a /clear)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(p, line({ type: "assistant", message: { role: "assistant", model: "m", usage: { input_tokens: 50, output_tokens: 1 } } }).repeat(3));
    let cur = advance(p, newCursor());
    expect(cur.tokens.input).toBe(150);
    writeFileSync(p, line({ type: "assistant", message: { role: "assistant", model: "m", usage: { input_tokens: 2, output_tokens: 1 } } }));
    cur = advance(p, cur);
    expect(cur.tokens.input).toBe(2);
  });
});
