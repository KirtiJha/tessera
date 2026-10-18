import { describe, expect, it } from "vitest";
import { canonical } from "./audit.js";

describe("canonical json", () => {
  it("is independent of key order, recursively", () => {
    expect(canonical({ role: "admin", email: "a@b" })).toBe(canonical({ email: "a@b", role: "admin" }));
    expect(canonical({ a: { z: 1, y: [{ q: 2, p: 1 }] } })).toBe('{"a":{"y":[{"p":1,"q":2}],"z":1}}');
    expect(canonical([null, "x", 1.5, true])).toBe('[null,"x",1.5,true]');
  });
});
