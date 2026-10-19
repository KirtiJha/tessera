import type { Presence } from "@tessera/contract";
import { ArrowLeftRight, BellOff, BellRing, Laptop, Smartphone } from "lucide-react";
import { useState } from "react";
import { PRESENCE, usePersonal, type PushState } from "../lib/personal";
import { Button, Menu, MenuHeading, MenuItem, MenuSeparator, useToast } from "./ui";

const ICON: Record<Presence, typeof Laptop> = { desk: Laptop, auto: ArrowLeftRight, away: Smartphone };
const ORDER: Presence[] = ["desk", "auto", "away"];

/** Three-way choice of where prompts should be answered. Saved on the server: every machine of yours follows it. */
export function PresencePicker({ className = "" }: { className?: string }) {
  const { presence, setPresence } = usePersonal();
  const toast = useToast();
  return (
    <div className={className}>
      <div role="radiogroup" aria-label="Where you answer prompts" className="flex rounded-lg border border-line bg-slate-1 p-0.5">
        {ORDER.map((p) => {
          const Icon = ICON[p];
          const on = presence === p;
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => void setPresence(p).then(() => toast(p === "away" ? "Away: prompts wait up to 10 minutes for you here." : p === "desk" ? "At your desk: prompts go to the terminal after 15 s." : "Prompts wait 55 s here, then the terminal asks.")).catch(() => toast("Could not save that.", "error"))}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] ${on ? (p === "away" ? "bg-violet-400/20 text-violet-300" : "bg-slate-3 text-snow") : "text-fog hover:text-snow"}`}
            >
              <Icon size={14} /> {PRESENCE[p].label}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[12px] text-fog">{PRESENCE[presence].help}</p>
    </div>
  );
}

/** Top-bar control: quiet unless you are away, which it shows plainly so it is not forgotten. */
export function PresenceChip() {
  const { presence, setPresence, loaded } = usePersonal();
  if (!loaded) return null;
  const Icon = ICON[presence];
  const away = presence === "away";
  return (
    <Menu
      label={`Answering: ${PRESENCE[presence].label}`}
      width={300}
      button={
        <span className="inline-flex items-center gap-1.5">
          <Icon size={15} />
          <span className={away ? "text-[12px] font-medium" : "hidden"}>Away</span>
        </span>
      }
      className={away ? "h-8 rounded-md border border-violet-400/40 bg-violet-400/15 px-2 text-violet-300 hover:bg-violet-400/25" : "h-9 w-9 text-mist hover:bg-slate-2 hover:text-snow"}
    >
      <MenuHeading>
        <div className="text-[13px] font-medium text-snow">Where do you answer prompts?</div>
        <div className="text-[12px] text-fog">Every machine of yours follows this.</div>
      </MenuHeading>
      <MenuSeparator />
      {ORDER.map((p) => {
        const I = ICON[p];
        return (
          <MenuItem key={p} icon={<I size={15} />} onSelect={() => void setPresence(p)}>
            <span className="flex flex-col">
              <span className={presence === p ? "font-medium text-snow" : ""}>{PRESENCE[p].label}{presence === p ? " ✓" : ""}</span>
              <span className="text-[11.5px] text-fog">{PRESENCE[p].help}</span>
            </span>
          </MenuItem>
        );
      })}
    </Menu>
  );
}

const PUSH_HELP: Record<PushState, string> = {
  on: "This device gets notifications.",
  off: "This device does not get notifications yet.",
  denied: "Notifications are blocked for this site. Allow them in the browser's site settings, then come back.",
  unsupported: "This browser cannot receive push notifications.",
  "ios-install": "On iPhone and iPad: tap Share, then Add to Home Screen, open Tessera from the Home Screen, and turn notifications on there.",
};

/** Push on this device, a test, and which events notify you. */
export function NotificationSettings() {
  const { push, pushDevices, notify, setNotify, enablePush, disablePush, testPush, presence } = usePersonal();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(e instanceof Error ? e.message : "That did not work.", "error");
    } finally {
      setBusy(false);
    }
  };
  const toggle = (k: keyof typeof notify, label: string, help: string) => (
    <label className="flex cursor-pointer items-start gap-3 py-2">
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-teal-400" checked={notify[k]} onChange={(e) => void setNotify({ [k]: e.target.checked })} />
      <span>
        <span className="block text-[13.5px] text-snow">{label}</span>
        <span className="block text-[12px] text-fog">{help}</span>
      </span>
    </label>
  );
  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          {push === "on" ? <BellRing size={16} className="text-teal-300" /> : <BellOff size={16} className="text-fog" />}
          <span className="text-[13.5px] text-snow">{push === "on" ? "On for this device" : "Push notifications"}</span>
          <span className="ml-auto flex gap-2">
            {push === "on" ? (
              <>
                <Button size="sm" loading={busy} onClick={() => void run(async () => toast((await testPush()) ? "Sent. It should appear in a few seconds." : "Nothing was sent: no device is subscribed.", "info"))}>Send a test</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(disablePush)}>Turn off here</Button>
              </>
            ) : push === "off" ? (
              <Button size="sm" variant="primary" loading={busy} onClick={() => void run(async () => { const s = await enablePush(); if (s === "on") toast("Notifications are on for this device."); })}>Turn on for this device</Button>
            ) : null}
          </span>
        </div>
        <p className="mt-1.5 text-[12px] text-fog">{PUSH_HELP[push]} {pushDevices ? `${pushDevices} device${pushDevices > 1 ? "s" : ""} subscribed in all.` : ""}</p>
        {presence === "desk" ? <p className="mt-1 text-[12px] text-amber-400/90">You are set to “At my desk”, so nothing is pushed until you switch to Either or Away.</p> : null}
      </div>
      <div className="divide-y divide-line border-t border-line">
        {toggle("waiting", "A prompt or question is waiting on you", "With Allow and Deny on the notification where the device supports it.")}
        {toggle("done", "A long turn has finished", "When a session that worked for at least 90 seconds stops: files changed, cost, and how long it took.")}
        {toggle("failed", "An agent failed", "With the failure summary.")}
      </div>
    </div>
  );
}
