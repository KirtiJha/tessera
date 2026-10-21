import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { clean, unifiedPatch, type ActionDetail } from "@tessera/contract";

/** Files larger than this are not read to work out what an edit changed. */
const READ_MAX = 1024 * 1024;
const TAIL_LINES = 40;
const TAIL_CHARS = 6000;

function readText(path: string): string | null {
  try {
    if (statSync(path).size > READ_MAX) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** What an edit or write does to its file, worked out before it runs: the file as it is, and as it will be. */
function change(tool: string, i: Record<string, unknown>, cwd: string | null): { before: string; after: string; firstLine: number } | null {
  const raw = typeof i.file_path === "string" ? i.file_path : null;
  if (!raw) return null;
  const path = isAbsolute(raw) || !cwd ? raw : resolve(cwd, raw);
  if (tool === "Write" && typeof i.content === "string") return { before: readText(path) ?? "", after: i.content, firstLine: 1 };
  if (tool === "Edit" && typeof i.old_string === "string" && typeof i.new_string === "string") {
    const text = readText(path);
    const at = text ? text.indexOf(i.old_string) : -1;
    // Numbered from where the old text starts, when it can be found.
    const firstLine = at >= 0 ? text!.slice(0, at).split("\n").length : 1;
    return { before: i.old_string, after: i.new_string, firstLine };
  }
  if (tool === "MultiEdit" && Array.isArray(i.edits)) {
    const text = readText(path);
    if (text === null) return null;
    let after = text;
    for (const e of i.edits as { old_string?: unknown; new_string?: unknown; replace_all?: unknown }[]) {
      if (typeof e?.old_string !== "string" || typeof e.new_string !== "string") continue;
      after = e.replace_all ? after.split(e.old_string).join(e.new_string) : after.replace(e.old_string, () => e.new_string as string);
    }
    return { before: text, after, firstLine: 1 };
  }
  return null;
}

/**
 * What a tool call is beyond its summary, redacted: the whole command, the
 * path or pattern, the lines an edit adds and removes, and (only when the
 * organisation keeps edits) the patch itself.
 */
export function callDetail(tool: string, input: Record<string, unknown> | undefined, cwd: string | null, keepEdits: boolean): ActionDetail | undefined {
  const i = input ?? {};
  const d: ActionDetail = {};
  if (typeof i.command === "string") d.command = clean(i.command, 4000);
  if (typeof i.description === "string") d.description = clean(i.description, 500);
  const path = i.file_path ?? i.notebook_path ?? i.path;
  if (typeof path === "string") d.path = clean(path, 400);
  if (typeof i.pattern === "string") d.pattern = clean(i.pattern, 400);
  if (typeof i.url === "string") d.url = clean(i.url, 1000);
  const c = change(tool, i, cwd);
  if (c) {
    const p = unifiedPatch(c.before, c.after, c.firstLine);
    d.added = p.added;
    d.removed = p.removed;
    if (keepEdits && p.patch) {
      d.patch = clean(p.patch, 20_100);
      if (p.truncated) d.patchTruncated = true;
    }
  }
  return Object.keys(d).length ? d : undefined;
}

/** A failed call's whole error text, as its output: the 300 characters on the row are often not the useful part. */
export function errorOutput(text: string | undefined): Pick<ActionDetail, "output"> {
  return text ? outputDetail("Bash", { stderr: text }) : {};
}

/** The last lines a command printed, stdout then stderr, redacted. Only Bash: other tools' output is file contents or pages. */
export function outputDetail(tool: string | undefined, response: unknown): Pick<ActionDetail, "output" | "interrupted"> {
  if (tool !== "Bash" || !response || typeof response !== "object") return {};
  const r = response as { stdout?: unknown; stderr?: unknown; interrupted?: unknown };
  const out = [typeof r.stdout === "string" ? r.stdout : "", typeof r.stderr === "string" ? r.stderr : ""].filter(Boolean).join("\n").replace(/\n+$/, "");
  const lines = out ? out.split("\n") : [];
  let tail = lines.slice(-TAIL_LINES).join("\n");
  if (tail.length > TAIL_CHARS) tail = tail.slice(-TAIL_CHARS);
  return {
    ...(r.interrupted === true ? { interrupted: true } : {}),
    ...(lines.length ? { output: { tail: clean(tail, TAIL_CHARS), lines: lines.length, truncated: lines.length > TAIL_LINES || tail.length >= TAIL_CHARS } } : {}),
  };
}
