import { describe, expect, it } from "vitest";
import { decrypt, encrypt, hashPassword, newToken, verifyPassword } from "./crypto.js";

describe("crypto", () => {
  it("hashes and verifies passwords with scrypt", async () => {
    const h = await hashPassword("correct-horse-battery");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct-horse-battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
  });
  it("round-trips secrets through AES-GCM", () => {
    const enc = encrypt("https://hooks.slack.com/services/T0/B0/xyz");
    expect(enc.startsWith("v1.")).toBe(true);
    expect(decrypt(enc)).toBe("https://hooks.slack.com/services/T0/B0/xyz");
    expect(() => decrypt(enc.slice(0, -2) + "zz")).toThrow();
  });
  it("mints prefixed random tokens", () => {
    const a = newToken("tsr");
    const b = newToken("tsr");
    expect(a).toMatch(/^tsr_[A-Za-z0-9_-]{40,}$/);
    expect(a).not.toBe(b);
  });
});
