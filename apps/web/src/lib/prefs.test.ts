import { describe, expect, it } from "vitest";
import { readPref, writePref } from "./prefs";

function fakeStorage(initial: Record<string, string> = {}, opts: { throwOnSet?: boolean } = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => {
      if (opts.throwOnSet) throw new DOMException("QuotaExceededError");
      m.set(k, v);
    },
  };
}

describe("preferences", () => {
  it("round-trips a value under the tessera. prefix", () => {
    const s = fakeStorage();
    writePref("nav", "rail", s);
    expect(s.getItem("tessera.nav")).toBe('"rail"');
    expect(readPref("nav", "expanded", s)).toBe("rail");
  });

  it("falls back when the key is missing", () => {
    expect(readPref("theme", "dark", fakeStorage())).toBe("dark");
  });

  it("falls back when the stored value is not JSON", () => {
    expect(readPref("theme", "dark", fakeStorage({ "tessera.theme": "light" }))).toBe("dark");
  });

  it("falls back when storage is unavailable", () => {
    expect(readPref("theme", "dark", null)).toBe("dark");
  });

  it("swallows a write that storage refuses", () => {
    expect(() => writePref("theme", "light", fakeStorage({}, { throwOnSet: true }))).not.toThrow();
    expect(() => writePref("theme", "light", null)).not.toThrow();
  });
});
