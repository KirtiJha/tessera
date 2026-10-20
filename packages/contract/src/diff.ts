import { z } from "zod";

/**
 * The uncommitted diff of a live session, asked for from the console and
 * sent by the reporter on the engineer's machine. Redacted there, capped, and
 * kept by the server in memory only, for a short while: code is not stored.
 */

/** Most characters of one file's diff the reporter sends. */
export const DIFF_FILE_MAX = 20_000;
/** Most characters of all files' diffs together. */
export const DIFF_TOTAL_MAX = 200_000;
/** Most files in one diff. */
export const DIFF_FILES_MAX = 40;

export const DiffFile = z.object({
  path: z.string().max(400),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
  /** Unified diff text against HEAD; for an untracked file, its first lines as additions. */
  diff: z.string().max(DIFF_FILE_MAX),
  /** Cut at DIFF_FILE_MAX, or left out once DIFF_TOTAL_MAX was reached. */
  truncated: z.boolean().default(false),
  /** Binary, or too large to read: no text. */
  binary: z.boolean().default(false),
});
export type DiffFile = z.infer<typeof DiffFile>;

export const DiffUpload = z.object({
  requestId: z.string().min(1).max(80),
  /** Files the session's working tree has changed, at most DIFF_FILES_MAX. */
  files: z.array(DiffFile).max(DIFF_FILES_MAX).default([]),
  /** Files changed beyond those sent. */
  omitted: z.number().int().nonnegative().default(0),
  /** Why there is no diff: not a git repository, excerpts off on this machine, a network filter. */
  error: z.string().max(300).nullable().default(null),
});
export type DiffUpload = z.infer<typeof DiffUpload>;

/** What the console reads back. */
export interface DiffView {
  status: "none" | "pending" | "ready" | "error";
  requestedAt: string | null;
  requestedBy: string | null;
  receivedAt: string | null;
  files: DiffFile[];
  omitted: number;
  error: string | null;
}
