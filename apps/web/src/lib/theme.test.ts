import { describe, expect, it } from "vitest";
import { isThemeChoice, resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("is dark by default and when asked", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
  });
  it("is light when asked, whatever the system says", () => {
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });
  it("follows the system only when asked to", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
  });
});

describe("isThemeChoice", () => {
  it("accepts the three choices and nothing else", () => {
    expect(isThemeChoice("dark")).toBe(true);
    expect(isThemeChoice("light")).toBe(true);
    expect(isThemeChoice("system")).toBe(true);
    expect(isThemeChoice("auto")).toBe(false);
    expect(isThemeChoice(undefined)).toBe(false);
  });
});
