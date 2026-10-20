import type { SessionView } from "@tessera/contract";
import { describe, expect, it } from "vitest";
import { diffRows } from "../components/FileDiffs";
import { parseMoment } from "../components/Replay";
import { summarize } from "./summary";

const base = {
  id: "s", status: "ended", startedAt: "2026-10-20T10:00:00.000Z", endedAt: "2026-10-20T11:30:00.000Z", lastSeenAt: "2026-10-20T11:30:00.000Z",
  endReason: "exit", stopRequested: false, blowouts: 0, context: null, costUsd: 3.2, plan: null,
  tokens: { input: 1000, output: 500, cacheRead: 9000, cacheWrite: 0 }, toolCalls: { Bash: 12, Read: 30 }, agents: [],
  git: { repo: "acme/pay", branch: "b", worktree: null, ahead: 2, behind: 0, modified: 1 },
  filesChanged: [{ path: "a.ts", status: "modified", added: 10, removed: 2 }],
} as unknown as SessionView;
const ask = (from: string, to: string | null, answeredBy: string | null) => ({ createdAt: from, closedAt: to, outcome: answeredBy ? "answered" : "closed", answeredBy });

describe("summarize", () => {
  it("tells how long it ran, what it left behind and how long it waited on people", () => {
    const m = summarize(base, [ask("2026-10-20T10:10:00.000Z", "2026-10-20T10:12:00.000Z", "Ann"), ask("2026-10-20T10:40:00.000Z", "2026-10-20T10:40:30.000Z", null)]);
    expect(m.durationMs).toBe(90 * 60_000);
    expect(m.verdict).toBe("ok");
    expect(m.headline).toBe("Left 1 file changed and 2 commits to push.");
    expect(m.prompts).toEqual({ asked: 2, answeredHere: 1, totalWaitMs: 150_000, longestWaitMs: 120_000 });
    expect(m.topTools[0]).toEqual({ tool: "Read", calls: 30 });
    expect(m.cacheShare).toBeCloseTo(0.9);
  });
  it("says a session with a failed agent or a blowout had problems, and a stopped one was stopped", () => {
    expect(summarize({ ...base, blowouts: 1 } as SessionView, []).verdict).toBe("issues");
    expect(summarize({ ...base, agents: [{ kind: "subagent", status: "failed", toolCalls: {} }] } as unknown as SessionView, []).agents).toEqual({ ran: 1, failed: 1 });
    const stopped = summarize({ ...base, endReason: "stopped from Tessera" } as SessionView, []);
    expect(stopped.verdict).toBe("stopped");
    expect(stopped.headline).toBe("Stopped before it finished.");
    expect(summarize({ ...base, filesChanged: [], git: null } as unknown as SessionView, []).headline).toBe("Changed no files.");
  });
});

describe("diffRows", () => {
  it("numbers old and new lines from each hunk and drops the file headers", () => {
    const rows = diffRows("diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -3,3 +3,3 @@ fn\n keep\n-old\n+new\n keep2\n\\ No newline at end of file\n");
    expect(rows.map((r) => [r.kind, r.old, r.new, r.text])).toEqual([
      ["hunk", null, null, "@@ -3,3 +3,3 @@ fn"],
      ["ctx", 3, 3, "keep"],
      ["del", 4, null, "old"],
      ["add", null, 4, "new"],
      ["ctx", 5, 5, "keep2"],
      ["note", null, null, "No newline at end of file"],
    ]);
  });
});

describe("parseMoment", () => {
  const t0 = Date.parse("2026-10-20T10:00:00.000Z");
  it("reads seconds from the start, or a moment, and ignores anything else", () => {
    expect(parseMoment("754", t0)).toBe(754_000);
    expect(parseMoment("2026-10-20T10:01:00.000Z", t0)).toBe(60_000);
    expect(parseMoment("soon", t0)).toBeNull();
    expect(parseMoment(null, t0)).toBeNull();
  });
});
