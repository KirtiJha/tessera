import { useSyncExternalStore } from "react";

/**
 * The session the person is looking at: the focused card on the wall, or the
 * session page they are on. The command palette and the wall's keys read it,
 * and ask the shell to act on it through a one-slot request, so "pause",
 * "hand over" and "message" work from anywhere without each page wiring them.
 */
export interface FocusedSession {
  id: string;
  label: string;
}
export interface ActionRequest {
  kind: "pause" | "resume" | "stop" | "message" | "handover";
  id: string;
  label: string;
}

function cell<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      for (const l of listeners) l();
    },
    use(): T {
      return useSyncExternalStore(
        (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        () => value,
        () => value,
      );
    },
  };
}

const focused = cell<FocusedSession | null>(null);
const request = cell<ActionRequest | null>(null);

export function setFocusedSession(next: FocusedSession | null): void {
  const cur = focused.get();
  if (cur?.id === next?.id && cur?.label === next?.label) return;
  focused.set(next);
}
export const useFocusedSession = (): FocusedSession | null => focused.use();

export const requestSessionAction = (a: ActionRequest | null): void => request.set(a);
export const useSessionActionRequest = (): ActionRequest | null => request.use();
