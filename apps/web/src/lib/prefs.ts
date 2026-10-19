import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Per-browser preferences (theme, navigation width, wall filter). They live in
 * localStorage under a `tessera.` prefix: a phone and a desk monitor legitimately
 * want different answers, so nothing here goes to the server.
 */
const PREFIX = "tessera.";
const CHANGED = "tessera:pref";

/** localStorage may be missing or throw (private windows, blocked site data); treat it as absent. */
function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readPref<T>(key: string, fallback: T, s: Storage | null = store()): T {
  try {
    const raw = s?.getItem(PREFIX + key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref<T>(key: string, value: T, s: Storage | null = store()): void {
  try {
    s?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the preference holds for this page only.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHANGED, { detail: key }));
}

/**
 * A preference as state. Reads once, writes on every change, and follows changes
 * made elsewhere: another component with the same key, or another tab.
 */
export function usePref<T>(key: string, fallback: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback));
  const current = useRef(value);
  current.current = value;
  const fb = useRef(fallback);
  fb.current = fallback;

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const v = typeof next === "function" ? (next as (prev: T) => T)(current.current) : next;
      current.current = v;
      setValue(v);
      writePref(key, v);
    },
    [key],
  );

  useEffect(() => {
    const reread = () => setValue(readPref(key, fb.current));
    const onLocal = (e: Event) => (e as CustomEvent<string>).detail === key && reread();
    const onOtherTab = (e: StorageEvent) => e.key === PREFIX + key && reread();
    window.addEventListener(CHANGED, onLocal);
    window.addEventListener("storage", onOtherTab);
    return () => {
      window.removeEventListener(CHANGED, onLocal);
      window.removeEventListener("storage", onOtherTab);
    };
  }, [key]);

  return [value, set];
}
