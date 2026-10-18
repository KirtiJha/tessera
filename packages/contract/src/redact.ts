/**
 * Redaction shared by reporters and the server edge. Pattern rules catch the
 * well-known secret shapes; the entropy check catches long random strings the
 * patterns do not know. Everything that looks like a secret becomes
 * "[redacted]" before it is sent or stored.
 */

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\s*[=:]\s*["']?[^\s"'&;]{6,}/gi,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const HIGH_ENTROPY_TOKEN = /(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_=-]{32,}(?![A-Za-z0-9+_=-])/g;

export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (m, key?: string) => (typeof key === "string" && /^(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)$/i.test(key) ? `${key}=[redacted]` : "[redacted]"));
  }
  out = out.replace(HIGH_ENTROPY_TOKEN, (m) => {
    if (/^[0-9a-f-]+$/i.test(m)) return m; // uuids, git shas, hex ids are not secrets
    if (/^[0-9]+$/.test(m)) return m;
    const upperLower = /[a-z]/.test(m) && /[A-Z]/.test(m);
    const letterDigit = /[a-zA-Z]/.test(m) && /[0-9]/.test(m);
    const h = shannonEntropy(m);
    return (upperLower && h > 4.2) || (letterDigit && h > 4.6) ? "[redacted]" : m;
  });
  return out;
}

export function stripControl(text: string): string {
  // Keep tab and newline; drop other C0 controls and DEL.
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
}

export function clean(text: string, max: number): string {
  const t = stripControl(redact(text));
  return t.length > max ? t.slice(0, max) : t;
}
