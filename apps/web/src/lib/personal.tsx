import type { Presence } from "@tessera/contract";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";

/**
 * The signed-in person's own settings: away mode, which notifications they
 * want, and whether this browser receives push notifications.
 */

export interface NotifyPrefs {
  waiting: boolean;
  done: boolean;
  failed: boolean;
}

export type PushState = "unsupported" | "denied" | "off" | "on" | "ios-install";

interface Personal {
  loaded: boolean;
  presence: Presence;
  notify: NotifyPrefs;
  pushDevices: number;
  push: PushState;
  setPresence: (p: Presence) => Promise<void>;
  setNotify: (n: Partial<NotifyPrefs>) => Promise<void>;
  enablePush: () => Promise<PushState>;
  disablePush: () => Promise<void>;
  testPush: () => Promise<number>;
}

const Ctx = createContext<Personal | null>(null);

export const PRESENCE: Record<Presence, { label: string; short: string; help: string }> = {
  desk: { label: "At my desk", short: "Desk", help: "Prompts go to the terminal after 15 s. No push notifications." },
  auto: { label: "Either", short: "Either", help: "Prompts wait 55 s for Tessera, then the terminal asks." },
  away: { label: "Away", short: "Away", help: "Prompts wait up to 10 minutes for you here or on your phone." },
};

function urlBase64ToBytes(base64: string): Uint8Array {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

async function currentPushState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    // iPhone and iPad offer Web Push only to a site added to the Home Screen.
    return isIos() && !standalone() ? "ios-install" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

export function PersonalProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [presence, setPresenceState] = useState<Presence>("auto");
  const [notify, setNotifyState] = useState<NotifyPrefs>({ waiting: true, done: true, failed: true });
  const [pushDevices, setPushDevices] = useState(0);
  const [pushKey, setPushKey] = useState<string | null>(null);
  const [push, setPush] = useState<PushState>("off");

  useEffect(() => {
    let alive = true;
    void api
      .get<{ presence: Presence; notify: NotifyPrefs; pushDevices: number; pushKey: string }>("/api/me/preferences")
      .then((r) => {
        if (!alive) return;
        setPresenceState(r.presence);
        setNotifyState(r.notify);
        setPushDevices(r.pushDevices);
        setPushKey(r.pushKey);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    void currentPushState().then((s) => alive && setPush(s)).catch(() => {});
    // Register early so a notification click always has a worker to land on.
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const setPresence = useCallback(async (p: Presence) => {
    setPresenceState(p);
    const r = await api.put<{ presence: Presence }>("/api/me/preferences", { presence: p });
    setPresenceState(r.presence);
  }, []);

  const setNotify = useCallback(async (n: Partial<NotifyPrefs>) => {
    setNotifyState((cur) => ({ ...cur, ...n }));
    const r = await api.put<{ notify: NotifyPrefs }>("/api/me/preferences", { notify: n });
    setNotifyState(r.notify);
  }, []);

  const enablePush = useCallback(async (): Promise<PushState> => {
    const state = await currentPushState();
    if (state === "unsupported" || state === "ios-install" || state === "denied") {
      setPush(state);
      return state;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPush(permission === "denied" ? "denied" : "off");
      return permission === "denied" ? "denied" : "off";
    }
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    let key = pushKey;
    if (!key) key = (await api.get<{ pushKey: string }>("/api/me/preferences")).pushKey;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(key) as BufferSource }));
    const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    const r = await api.post<{ pushDevices: number }>("/api/me/push", { endpoint: json.endpoint, keys: json.keys, label: deviceLabel() });
    setPushDevices(r.pushDevices);
    setPush("on");
    return "on";
  }, [pushKey]);

  const disablePush = useCallback(async () => {
    const reg = await navigator.serviceWorker?.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      const r = await api.post<{ pushDevices: number }>("/api/me/push/remove", { endpoint: sub.endpoint });
      setPushDevices(r.pushDevices);
      await sub.unsubscribe();
    }
    setPush("off");
  }, []);

  const testPush = useCallback(async () => (await api.post<{ sent: number }>("/api/me/push/test")).sent, []);

  const value = useMemo<Personal>(() => ({ loaded, presence, notify, pushDevices, push, setPresence, setNotify, enablePush, disablePush, testPush }), [loaded, presence, notify, pushDevices, push, setPresence, setNotify, enablePush, disablePush, testPush]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${browser} on ${os}`;
}

export function usePersonal(): Personal {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePersonal outside PersonalProvider");
  return v;
}
