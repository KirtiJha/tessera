import { OctagonX, Pause, Play, Send, X } from "lucide-react";
import { useState } from "react";
import { Button, Modal, Textarea } from "./ui";

/**
 * The bar that appears once sessions are selected on the wall. Pause and resume
 * act at once; stop and message ask what to say first. The server decides per
 * session whether the person may act, so the wall just tries each and reports.
 */
export function BulkBar({ count, shown, busy, onSelectAll, onClear, onPause, onResume, onStop, onMessage }: { count: number; shown: number; busy: string | null; onSelectAll: () => void; onClear: () => void; onPause: () => void; onResume: () => void; onStop: (reason: string) => void; onMessage: (text: string) => void }) {
  const [stopOpen, setStopOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [msgOpen, setMsgOpen] = useState(false);
  const [text, setText] = useState("");
  if (!count) return null;
  return (
    <>
      <div role="toolbar" aria-label="Selected sessions" className="fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-xl border border-line-2 bg-slate-1 px-3 py-2 shadow-2xl">
        <span className="text-[13px] font-medium text-snow">{count} selected</span>
        {count < shown ? <button type="button" onClick={onSelectAll} className="text-[12.5px] text-fog hover:text-snow">Select all {shown} shown</button> : null}
        <span className="mx-1 h-5 border-l border-line" />
        <Button size="sm" loading={busy === "pause"} disabled={!!busy} onClick={onPause}><Pause size={14} /> Pause</Button>
        <Button size="sm" loading={busy === "resume"} disabled={!!busy} onClick={onResume}><Play size={14} /> Resume</Button>
        <Button size="sm" disabled={!!busy} onClick={() => setMsgOpen(true)}><Send size={14} /> Message</Button>
        <Button size="sm" variant="danger" loading={busy === "stop"} disabled={!!busy} onClick={() => setStopOpen(true)}><OctagonX size={14} /> Stop</Button>
        <button type="button" onClick={onClear} aria-label="Clear selection" className="ml-1 rounded-md p-1 text-fog hover:bg-slate-2 hover:text-snow"><X size={16} /></button>
      </div>

      <Modal open={stopOpen} onClose={() => setStopOpen(false)} title={`Stop ${count} session${count === 1 ? "" : "s"}?`}>
        <p className="text-[13.5px] text-mist">Each session refuses its next tool call and ends its turn, handing control back to its engineer. It applies once; they can carry on afterwards.</p>
        <Textarea className="mt-3" rows={2} placeholder="Why (optional). The engineer sees this in the terminal." value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setStopOpen(false)}>Keep running</Button>
          <Button variant="danger" onClick={() => { setStopOpen(false); onStop(reason.trim()); setReason(""); }}>Stop {count}</Button>
        </div>
      </Modal>

      <Modal open={msgOpen} onClose={() => setMsgOpen(false)} title={`Message ${count} session${count === 1 ? "" : "s"}`}>
        <p className="text-[13.5px] text-mist">Delivered to each the next time it pauses, as an instruction to continue with.</p>
        <Textarea className="mt-3" rows={4} autoFocus placeholder="For example: stop after the current task and push what you have." value={text} onChange={(e) => setText(e.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setMsgOpen(false)}>Cancel</Button>
          <Button variant="primary" disabled={!text.trim()} onClick={() => { setMsgOpen(false); onMessage(text.trim()); setText(""); }}>Send to {count}</Button>
        </div>
      </Modal>
    </>
  );
}
