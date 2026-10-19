import { Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { usePref } from "../lib/prefs";
import { useTheme, type ThemeChoice } from "../lib/theme";
import type { Density } from "../lib/wallLayout";
import { Segmented } from "./ui";

// Controls for the per-browser preferences. The user menu and the Account page both show them.

export type NavWidth = "expanded" | "rail";

/** How much each wall card shows. Compact fits about a third more on a screen. */
export function useDensity(): [Density, (d: Density) => void] {
  const [stored, set] = usePref<Density>("wall.density", "comfortable");
  return [stored === "compact" ? "compact" : "comfortable", set];
}

export function DensityPicker({ size, className }: { size?: "sm" | "md"; className?: string }) {
  const [density, setDensity] = useDensity();
  return (
    <Segmented
      label="Wall density"
      value={density}
      onChange={setDensity}
      options={[
        { value: "comfortable", label: "Comfortable" },
        { value: "compact", label: "Compact" },
      ]}
      size={size}
      className={className}
    />
  );
}

/** How wide the left navigation is on large screens. Phones always get the slide-in menu. */
export function useNavWidth(): [NavWidth, (w: NavWidth) => void] {
  const [stored, set] = usePref<NavWidth>("nav", "expanded");
  return [stored === "rail" ? "rail" : "expanded", set];
}

const THEMES: { value: ThemeChoice; label: string; icon: ReactNode }[] = [
  { value: "dark", label: "Dark", icon: <Moon size={14} /> },
  { value: "light", label: "Light", icon: <Sun size={14} /> },
  { value: "system", label: "System", icon: <Monitor size={14} /> },
];

export function ThemePicker({ size, className }: { size?: "sm" | "md"; className?: string }) {
  const { choice, setChoice } = useTheme();
  return <Segmented label="Theme" value={choice} onChange={setChoice} options={THEMES} size={size} className={className} />;
}

export function NavWidthPicker({ size, className }: { size?: "sm" | "md"; className?: string }) {
  const [width, setWidth] = useNavWidth();
  return (
    <Segmented
      label="Navigation width"
      value={width}
      onChange={setWidth}
      options={[
        { value: "expanded", label: "Expanded" },
        { value: "rail", label: "Icon rail" },
      ]}
      size={size}
      className={className}
    />
  );
}
