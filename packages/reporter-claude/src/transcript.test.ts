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

describe("advance on a large transcript", async () => {
  const { appendFileSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { advance, newCursor } = await import("./transcript.js");
  const dir = mkdtempSync(join(tmpdir(), "tessera-big-"));
  const line = (i: number) => JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, content: [{ type: "text", text: `turn ${i} — é漢字🙂 ${"x".repeat(200)}` }] } }) + "\n";

  it("reads at most its budget per call, catches up over later calls, and never splits a character", () => {
    const p = join(dir, "big.jsonl");
    const n = 3000;
    writeFileSync(p, Array.from({ length: n }, (_, i) => line(i)).join(""));
    let cur = newCursor();
    let calls = 0;
    // A budget far smaller than the file: it takes several calls, each bounded.
    for (; calls < 100; calls++) {
      const before = cur.offset;
      cur = advance(p, cur, 128 * 1024);
      expect(cur.offset - before).toBeLessThanOrEqual(128 * 1024);
      if (cur.tokens.output === 2 * n) break;
    }
    expect(calls).toBeGreaterThan(2);
    expect(cur.tokens).toEqual({ input: n, output: 2 * n, cacheRead: 3 * n, cacheWrite: 4 * n });
    expect(cur.lastAssistantText).toContain(`turn ${n - 1} — é漢字🙂`);
  });

  it("skips a line longer than a chunk instead of buffering it, then reads on", () => {
    const p = join(dir, "long.jsonl");
    writeFileSync(p, line(0) + JSON.stringify({ type: "user", message: { content: "y".repeat(9 * 1024 * 1024) } }) + "\n" + line(1));
    let cur = newCursor();
    for (let i = 0; i < 5; i++) cur = advance(p, cur);
    expect(cur.tokens.output).toBe(4);
    expect(cur.partial).toBe("");
  });

  it("leaves a line that is still being written for the next call", () => {
    const p = join(dir, "growing.jsonl");
    const full = line(7);
    writeFileSync(p, line(6) + full.slice(0, 40));
    let cur = advance(p, newCursor());
    expect(cur.tokens.output).toBe(2);
    appendFileSync(p, full.slice(40));
    cur = advance(p, cur);
    expect(cur.tokens.output).toBe(4);
    rmSync(dir, { recursive: true, force: true });
  });
});
