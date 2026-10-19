import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installPs1, installSh } from "./installers.js";

describe("installers", () => {
  it("bake the server's address in and parse as shell", () => {
    const sh = installSh("https://tessera.example.com");
    expect(sh).toContain('SERVER="https://tessera.example.com"');
    expect(sh).toContain("/downloads/tessera-reporter.mjs");
    expect(sh).toContain("nodejs.org/dist/");
    // POSIX sh accepts it (syntax only).
    const dir = mkdtempSync(join(tmpdir(), "tessera-inst-"));
    try {
      writeFileSync(join(dir, "install.sh"), sh);
      expect(() => execFileSync("sh", ["-n", join(dir, "install.sh")], { stdio: "pipe" })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a PowerShell script that reads its inputs from the environment", () => {
    const ps = installPs1("https://tessera.example.com");
    expect(ps).toContain('"https://tessera.example.com"');
    expect(ps).toContain("$env:TESSERA_CODE");
    expect(ps).toContain("Invoke-WebRequest");
    expect(ps).not.toContain("param(");
    // Balanced braces: the usual way a generated script breaks.
    const open = (ps.match(/\{/g) ?? []).length;
    const close = (ps.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
  });
});
