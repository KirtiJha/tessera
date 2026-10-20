import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { Button, Modal, Select, Textarea, useToast } from "./ui";

export type SessionAction = { kind: "pause" | "resume" | "stop" | "message" | "handover"; id: string; label: string };

interface Person { id: string; name: string; role: string; team: string | null }

/**
 * The actions the command palette (and the wall's keys) can take on a session
 * from anywhere. Pause and resume go straight through; stop, message and
 * hand-over ask what to say or whom to pick first. The server decides whether
 * this person may act and says so if not.
 */
export function SessionActions({ action, onDone }: { action: SessionAction | null; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (action?.kind === "handover" && !people.length) void api.get<{ people: Person[] }>("/api/fleet/people").then((r) => setPeople(r.people)).catch(() => {});
  }, [action, people.length]);

  // Pause and resume need no input: do them as soon as they are asked for.
  useEffect(() => {
    if (!action || (action.kind !== "pause" && action.kind !== "resume")) return;
    const paused = action.kind === "pause";
    void api
      .post(`/api/fleet/sessions/${encodeURIComponent(action.id)}/pause`, { paused })
      .then(() => toast(`${action.label}: ${paused ? "paused; new tool calls are denied until resumed" : "resumed"}.`))
      .catch((e) => toast(e instanceof ApiError ? e.message : "Could not do that.", "error"))
      .finally(onDone);
  }, [action, onDone, toast]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      setText("");
      setTo("");
      onDone();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not do that.", "error");
    } finally {
      setBusy(false);
    }
  };
  if (!action || action.kind === "pause" || action.kind === "resume") return null;
  const path = (p: string) => `/api/fleet/sessions/${encodeURIComponent(action.id)}/${p}`;

  return (
    <>
      <Modal open={action.kind === "stop"} onClose={onDone} title={`Stop ${action.label}?`}>
        <p className="text-[13.5px] text-mist">The session refuses its next tool call and ends its turn, handing control back to its engineer. It applies once.</p>
        <Textarea className="mt-3" rows={2} autoFocus placeholder="Why (optional). The engineer sees this in the terminal." value={text} onChange={(e) => setText(e.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onDone}>Keep running</Button>
          <Button variant="danger" loading={busy} onClick={() => void run(() => api.post(path("stop"), text.trim() ? { reason: text.trim() } : {}), `${action.label}: stop requested.`)}>Stop</Button>
        </div>
      </Modal>
      <Modal open={action.kind === "message"} onClose={onDone} title={`Message ${action.label}`}>
        <p className="text-[13.5px] text-mist">Delivered the next time the session pauses, as an instruction to continue with.</p>
        <Textarea className="mt-3" rows={4} autoFocus placeholder="For example: stop after the current task and push what you have." value={text} onChange={(e) => setText(e.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onDone}>Cancel</Button>
          <Button variant="primary" disabled={!text.trim()} loading={busy} onClick={() => void run(() => api.post(path("message"), { text: text.trim() }), `${action.label}: message queued.`)}>Send</Button>
        </div>
      </Modal>
      <Modal open={action.kind === "handover"} onClose={onDone} title={`Hand ${action.label} to…`}>
        <p className="text-[13.5px] text-mist">They are told when it waits and can answer, stop or pause it. The owner stays the owner.</p>
        <div className="mt-3">
          <Select aria-label="Hand over to" value={to} onChange={(e) => setTo(e.target.value)} autoFocus>
            <option value="">Choose a person…</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.team ? ` · ${p.team}` : ""}</option>)}
          </Select>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onDone}>Cancel</Button>
          <Button variant="primary" disabled={!to} loading={busy} onClick={() => void run(() => api.post(path("assign"), { userId: to }), `${action.label}: handed over.`)}>Hand over</Button>
        </div>
      </Modal>
    </>
  );
}
