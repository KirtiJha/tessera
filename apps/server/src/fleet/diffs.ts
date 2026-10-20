import { applyDlp, type DiffUpload, type DiffView, type DlpSettings } from "@tessera/contract";

/**
 * Diffs asked for from the console, held in memory only and for fifteen
 * minutes: a diff is code, and Tessera keeps metadata, not code. A server
 * restart forgets them, and the person asks again. With several replicas a
 * diff lives on the replica that received it, so the view reads "none" on
 * another and the console offers to ask again.
 */
const TTL_MS = 15 * 60_000;
/** A machine that has not answered in this long is not going to: say so. */
const PENDING_MS = 60_000;

interface Entry {
  requestId: string;
  requestedAt: number;
  requestedBy: string;
  receivedAt: number | null;
  upload: DiffUpload | null;
}

const entries = new Map<string, Entry>();
const key = (orgId: string, sessionId: string) => `${orgId}:${sessionId}`;

function prune(now: number): void {
  for (const [k, e] of entries) if (now - (e.receivedAt ?? e.requestedAt) > TTL_MS) entries.delete(k);
}

/** A request still waiting for its machine, so a second click does not queue a second one. */
export function pendingRequest(orgId: string, sessionId: string, now = Date.now()): string | null {
  const e = entries.get(key(orgId, sessionId));
  return e && !e.receivedAt && now - e.requestedAt < PENDING_MS ? e.requestId : null;
}

export function requestDiff(orgId: string, sessionId: string, requestId: string, by: string, now = Date.now()): void {
  prune(now);
  entries.set(key(orgId, sessionId), { requestId, requestedAt: now, requestedBy: by, receivedAt: null, upload: null });
}

/** Store what the machine sent, with the organisation's DLP applied. False when nothing asked for it. */
export function receiveDiff(orgId: string, sessionId: string, upload: DiffUpload, dlp: DlpSettings, now = Date.now()): boolean {
  const e = entries.get(key(orgId, sessionId));
  if (!e || e.requestId !== upload.requestId) return false;
  e.receivedAt = now;
  e.upload = { ...upload, files: upload.files.map((f) => ({ ...f, diff: applyDlp(f.diff, dlp) })) };
  return true;
}

export function diffView(orgId: string, sessionId: string, now = Date.now()): DiffView {
  prune(now);
  const e = entries.get(key(orgId, sessionId));
  const base = { requestedAt: null, requestedBy: null, receivedAt: null, files: [], omitted: 0, error: null };
  if (!e) return { status: "none", ...base };
  const head = { requestedAt: new Date(e.requestedAt).toISOString(), requestedBy: e.requestedBy };
  if (!e.upload) {
    if (now - e.requestedAt < PENDING_MS) return { ...base, ...head, status: "pending" };
    return { ...base, ...head, status: "error", error: "The machine did not answer within a minute. It may be asleep, offline, or running a reporter from before diffs; ask again, or rerun the installer there." };
  }
  const u = e.upload;
  return { ...head, status: u.error ? "error" : "ready", receivedAt: new Date(e.receivedAt!).toISOString(), files: u.files, omitted: u.omitted, error: u.error };
}

export function forgetDiffs(): void {
  entries.clear();
}
