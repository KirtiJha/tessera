import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.TESSERA_HOME = mkdtempSync(join(tmpdir(), "tessera-git-home-"));
const { gitFiles, gitInfo } = await import("./transport.js");

const repo = mkdtempSync(join(tmpdir(), "tessera-git-"));
const sh = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeAll(() => {
  sh(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "gone.txt"), "x\n");
  writeFileSync(join(repo, "old.txt"), "same\nsame\n");
  sh(["add", "."]);
  sh(["commit", "-q", "-m", "base"]);
  writeFileSync(join(repo, "a.txt"), "one\n2\nthree\nfour\n"); // -1 +2
  writeFileSync(join(repo, "b.txt"), "l1\nl2\nl3\nl4"); // untracked, 4 lines, no trailing newline
  unlinkSync(join(repo, "gone.txt"));
  sh(["mv", "old.txt", "new.txt"]);
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(process.env.TESSERA_HOME!, { recursive: true, force: true });
});

describe("gitFiles", () => {
  it("lists each change with its status and line counts, biggest first", () => {
    const files = gitFiles(repo);
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(by["b.txt"]).toEqual({ path: "b.txt", status: "untracked", added: 4, removed: 0 });
    expect(by["a.txt"]).toEqual({ path: "a.txt", status: "modified", added: 2, removed: 1 });
    expect(by["gone.txt"]).toEqual({ path: "gone.txt", status: "deleted", added: 0, removed: 1 });
    expect(by["new.txt"]).toMatchObject({ status: "renamed", added: 0, removed: 0 });
    expect(files[0]!.path).toBe("b.txt");
    expect(files.some((f) => f.path === "old.txt")).toBe(false);
  });
  it("is empty outside a repository or without a directory", () => {
    expect(gitFiles(tmpdir())).toEqual([]);
    expect(gitFiles(null)).toEqual([]);
  });
  it("agrees with the summary's modified count", () => {
    expect(gitInfo(repo)?.modified).toBe(gitFiles(repo).length);
  });
});
