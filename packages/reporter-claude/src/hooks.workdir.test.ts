import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// config.ts reads TESSERA_HOME when it loads, so point it at a scratch home before importing anything.
const home = mkdtempSync(join(tmpdir(), "tessera-workdir-"));
process.env.TESSERA_HOME = home;
const { handle, workCandidate } = await import("./hooks.js");
const { loadState } = await import("./state.js");
const { buildReport } = await import("./transport.js");

const cfg = { serverUrl: "http://tessera.test", token: "tsr_test", label: "t", machineId: "m", excerpts: true, permissionWaitSeconds: 2, questionWaitSeconds: 1 };
const root = realpathSync(mkdtempSync(join(tmpdir(), "tessera-repos-")));

/** A repository with one committed file and one untracked file of its own. */
function repo(name: string, untracked: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  const sh = (args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  sh(["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "x\n");
  sh(["add", "."]);
  sh(["commit", "-q", "-m", "base"]);
  writeFileSync(join(dir, untracked), "new\n");
  return dir;
}
const started = repo("workflow", "deck.pptx");
const other = repo("porthaven", "src/netmap.py");

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("the folder a session works in", () => {
  it("is read from a write's path or a leading cd, never from a read", () => {
    expect(workCandidate("Edit", { file_path: "/w/porthaven/src/a.py" }, "/w/start")).toBe("/w/porthaven/src");
    expect(workCandidate("Bash", { command: "cd ~/porthaven && sed -n 1,5p a.py" }, "/w/start")).toBe(join(homedir(), "porthaven"));
    expect(workCandidate("Bash", { command: `cd "../my repo"; ls` }, "/w/start")).toBe("/w/my repo");
    expect(workCandidate("Bash", { command: "cd $REPO && ls" }, "/w/start")).toBeNull();
    expect(workCandidate("Bash", { command: "git status" }, "/w/start")).toBeNull();
    expect(workCandidate("Read", { file_path: "/w/porthaven/a.py" }, "/w/start")).toBeNull();
  });

  it("follows the session to the repository it works in, and its files and diffs come from there", async () => {
    const sid = "moved-repo";
    await handle(null, "SessionStart", { session_id: sid, cwd: started, source: "startup" });
    let report = buildReport(cfg, loadState(sid, null, null));
    expect(report.session.cwd).toBe(started);
    expect(report.session.filesChanged.map((f) => f.path)).toEqual(["deck.pptx"]);

    // Reading another repository is not working in it.
    await handle(null, "PostToolUse", { session_id: sid, cwd: started, tool_name: "Read", tool_input: { file_path: join(other, "README.md") }, tool_use_id: "r1" });
    expect(buildReport(cfg, loadState(sid, null, null)).session.cwd).toBe(started);

    await handle(null, "PostToolUse", { session_id: sid, cwd: started, tool_name: "Bash", tool_input: { command: `cd ${join(other, "src")} && python3 -m pytest` }, tool_use_id: "b1" });
    const s = loadState(sid, null, null);
    report = buildReport(cfg, s);
    expect(report.session.cwd).toBe(other);
    expect(report.session.git?.repo).toBe("porthaven");
    expect(report.session.filesChanged.map((f) => f.path)).toEqual(["src/netmap.py"]);
    expect(report.events.map((e) => e.text)).toContain(`Now working in ${other} (started in ${started})`);

    // Both repositories are listed, each with its own changes.
    expect(report.session.workedIn.map((w) => [w.dir, w.current, w.filesChanged.map((f) => f.path)])).toEqual([
      [started, false, ["deck.pptx"]],
      [other, true, ["src/netmap.py"]],
    ]);

    // A write back in the first repository moves it back.
    await handle(null, "PostToolUse", { session_id: sid, cwd: started, tool_name: "Write", tool_input: { file_path: join(started, "notes.md") }, tool_use_id: "w1" });
    expect(buildReport(cfg, loadState(sid, null, null)).session.cwd).toBe(started);
    expect(buildReport(cfg, loadState(sid, null, null)).session.workedIn.find((w) => w.current)?.dir).toBe(started);
  });

  it("ignores a write outside any repository", async () => {
    const sid = "scratch-write";
    await handle(null, "SessionStart", { session_id: sid, cwd: started, source: "startup" });
    await handle(null, "PostToolUse", { session_id: sid, cwd: started, tool_name: "Write", tool_input: { file_path: join(tmpdir(), "scratch.txt") }, tool_use_id: "w1" });
    expect(buildReport(cfg, loadState(sid, null, null)).session.cwd).toBe(started);
  });
});
