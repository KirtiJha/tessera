import { useEffect, type ReactNode } from "react";
import { usePref } from "./prefs";
import { useMedia } from "./useMedia";

export type ThemeChoice = "dark" | "light" | "system";
export type Theme = "dark" | "light";

/** The localStorage key (under the `tessera.` prefix) that index.html reads before first paint. */
export const THEME_KEY = "theme";
export const THEME_CHOICES: ThemeChoice[] = ["dark", "light", "system"];

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === "dark" || v === "light" || v === "system";
}

/** Dark unless asked for light, or asked to follow a system that prefers light. */
export function resolveTheme(choice: ThemeChoice, systemPrefersLight: boolean): Theme {
  return choice === "light" || (choice === "system" && systemPrefersLight) ? "light" : "dark";
}

export function useTheme(): { choice: ThemeChoice; setChoice: (c: ThemeChoice) => void; resolved: Theme } {
  const [stored, setChoice] = usePref<ThemeChoice>(THEME_KEY, "dark");
  const choice = isThemeChoice(stored) ? stored : "dark";
  const systemLight = useMedia("(prefers-color-scheme: light)");
  return { choice, setChoice, resolved: resolveTheme(choice, systemLight) };
}

/**
 * Applies the chosen theme to the document while mounted. The console and the
 * sign-in pages sit inside one; the landing page never does, so it stays
 * light-on-paper whatever the console is set to.
 */
export function ThemeScope({ children }: { children: ReactNode }) {
  const { resolved } = useTheme();
  useEffect(() => {
    const root = document.documentElement;
    if (resolved === "light") root.dataset.theme = "light";
    else delete root.dataset.theme;
    return () => {
      delete root.dataset.theme;
    };
  }, [resolved]);
  return <>{children}</>;
}
