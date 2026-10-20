import { clean, DIFF_FILE_MAX, DIFF_FILES_MAX, DIFF_TOTAL_MAX, type DiffFile, type DiffUpload } from "@tessera/contract";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gitFiles } from "./transport.js";

/** An untracked file larger than this is not read: it is shown as too large. */
const UNTRACKED_MAX_BYTES = 256 * 1024;

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** A new file as a diff that adds every line, so the console shows it the same way as a change. */
function untrackedDiff(top: string, path: string): { diff: string; binary: boolean } {
  try {
    const full = join(top, path);
    if (statSync(full).size > UNTRACKED_MAX_BYTES) return { diff: "", binary: true };
    const text = readFileSync(full, "utf8");
    if (text.includes("\0")) return { diff: "", binary: true };
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return { diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`, binary: false };
  } catch {
    return { diff: "", binary: true };
  }
}

/**
 * The session's uncommitted changes against HEAD, file by file, for a person
 * who asked for them in the console. Redacted like everything else the
 * reporter sends, cut at 20,000 characters a file and 200,000 in all.
 */
export function collectDiff(cwd: string | null, requestId: string, excerpts: boolean): DiffUpload {
  const none = (error: string): DiffUpload => ({ requestId, files: [], omitted: 0, error });
  if (!excerpts) return none("This machine is set to send no excerpts (excerpts is false in ~/.tessera/config.json), so it sends no diffs.");
  if (!cwd) return none("The session has no working directory.");
  const top = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!top) return none("The session's working directory is not a git repository.");
  const changed = gitFiles(top);
  if (!changed.length) return { requestId, files: [], omitted: 0, error: null };
  const files: DiffFile[] = [];
  let total = 0;
  for (const f of changed.slice(0, DIFF_FILES_MAX)) {
    const raw = f.status === "untracked" ? untrackedDiff(top, f.path) : { diff: git(top, ["diff", "HEAD", "--no-color", "--no-ext-diff", "-U3", "--", f.path]) ?? "", binary: false };
    const binary = raw.binary || /^Binary files .* differ$/m.test(raw.diff);
    const text = binary ? "" : clean(raw.diff, Number.MAX_SAFE_INTEGER);
    const room = Math.max(0, Math.min(DIFF_FILE_MAX, DIFF_TOTAL_MAX - total));
    const diff = text.slice(0, room);
    total += diff.length;
    files.push({ path: f.path, status: f.status, diff, truncated: diff.length < text.length, binary });
  }
  return { requestId, files, omitted: Math.max(0, changed.length - files.length), error: null };
}
