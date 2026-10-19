import { Check, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { usePersonal } from "../lib/personal";
import { PresencePicker } from "./PersonalSettings";
import { Button, useToast } from "./ui";

interface Device {
  id: string;
  label: string;
  hostname: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

function Step({ n, done, active, title, children }: { n: number; done: boolean; active: boolean; title: string; children?: ReactNode }) {
  return (
    <li className={`flex gap-3 rounded-lg px-3 py-3 ${active ? "bg-slate-2" : ""}`}>
      <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${done ? "bg-teal-400 text-ink" : active ? "border border-teal-400 text-teal-300" : "border border-line-2 text-fog"}`}>
        {done ? <Check size={14} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-[14px] font-medium ${done ? "text-fog line-through decoration-line-2" : "text-snow"}`}>{title}</div>
        {children && !done ? <div className="mt-1.5 text-[13px] leading-relaxed text-mist">{children}</div> : null}
      </div>
    </li>
  );
}

/**
 * What an empty wall shows: the few steps to a first session, each ticked off
 * from what has really happened (a machine enrolled, a session reported), plus
 * the two choices that make it useful away from the desk.
 */
export function FirstRun() {
  const { isAdmin } = useAuth();
  const { push, enablePush, presence } = usePersonal();
  const toast = useToast();
  const [devices, setDevices] = useState<Device[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void api.get<{ devices: Device[] }>("/api/admin/devices").then((r) => alive && setDevices(r.devices.filter((d) => !d.revokedAt))).catch(() => alive && setDevices([]));
    load();
    // The machine enrols from a terminal; notice it without a reload.
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const enrolled = (devices?.length ?? 0) > 0;
  const reported = devices?.some((d) => d.lastSeenAt) ?? false;
  return (
    <div className="mx-auto max-w-2xl rounded-xl border border-line bg-slate-1 p-5">
      <div className="text-[18px] font-semibold text-snow">Let's get your first session on the wall</div>
      <p className="mt-1 text-[13.5px] text-fog">About two minutes. Each step ticks itself off when it happens.</p>
      <ol className="mt-4 space-y-1">
        <Step n={1} done={enrolled} active={!enrolled} title="Connect the machine you run Claude Code on">
          Get a one-time code and paste one line in a terminal there.
          <div className="mt-2"><Link to="/app/devices" className="inline-flex h-8 items-center rounded-lg bg-teal-400 px-3 text-[13px] font-medium text-ink hover:bg-teal-300">Get the install line</Link></div>
        </Step>
        <Step n={2} done={false} active={enrolled} title="Start a Claude Code session">
          {enrolled ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              Run <code className="rounded bg-ink px-1.5 py-0.5 font-mono text-[12.5px] text-teal-300">claude</code> in any project on {devices!.map((d) => d.hostname ?? d.label).join(", ")} and give it a task. It appears here within seconds.
              <span className="inline-flex items-center gap-1.5 text-fog"><Loader2 size={13} className="animate-spin" /> {reported ? "connected; waiting for a session" : "waiting for the first report"}</span>
            </span>
          ) : (
            "Once the machine is connected, any session you start appears here within seconds."
          )}
        </Step>
        <Step n={3} done={presence !== "auto"} active={enrolled} title="Choose where you answer prompts">
          <PresencePicker className="mt-1" />
        </Step>
        <Step n={4} done={push === "on"} active={enrolled} title="Get notified when a session needs you">
          {push === "off" ? (
            <Button size="sm" onClick={() => void enablePush().then((s) => s === "on" && toast("Notifications are on for this device.")).catch(() => toast("Could not turn notifications on.", "error"))}>Turn on notifications here</Button>
          ) : push === "ios-install" ? (
            "On iPhone: tap Share, then Add to Home Screen, and turn notifications on from the app there."
          ) : push === "denied" ? (
            "Notifications are blocked for this site; allow them in the browser's site settings."
          ) : (
            "This browser cannot receive notifications; Slack works too (an admin can connect it under Notifications)."
          )}
        </Step>
      </ol>
      {isAdmin ? <p className="mt-4 border-t border-line pt-3 text-[12.5px] text-fog">Bringing your team? <Link to="/app/people" className="text-teal-300 hover:underline">Invite them</Link>; each person connects their own machine the same way.</p> : null}
    </div>
  );
}
