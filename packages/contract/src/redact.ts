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

// ---- data-loss prevention classes, applied at the server edge per organisation ----

export interface DlpSettings {
  emails: boolean;
  cards: boolean;
  nationalIds: boolean;
  ibans: boolean;
  /** Literal words or phrases (project code names, customer names), matched case-insensitively. */
  terms: string[];
}

export const DLP_OFF: DlpSettings = { emails: false, cards: false, nationalIds: false, ibans: false, terms: [] };

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function ibanOk(raw: string): boolean {
  const s = raw.replace(/ /g, "");
  if (s.length < 15 || s.length > 34) return false;
  const moved = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + (ch.charCodeAt(0) - 48)) % 97;
  return rem === 1;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replace personal and sensitive data the organisation has chosen to keep out
 * of Tessera. Card numbers are checked with Luhn and IBANs with mod 97, so
 * order numbers and build ids are left alone. Every pattern is linear.
 */
export function applyDlp(text: string, s: DlpSettings): string {
  let out = text;
  if (s.emails) out = out.replace(/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}\b/g, "[email]");
  if (s.cards) out = out.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => (luhn(m.replace(/[ -]/g, "")) ? "[card]" : m));
  if (s.nationalIds) out = out.replace(/\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, "[id-number]");
  if (s.ibans) out = out.replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, (m) => (ibanOk(m) ? "[iban]" : m));
  const terms = s.terms.map((t) => t.trim()).filter((t) => t.length >= 2);
  if (terms.length) out = out.replace(new RegExp(terms.map(escapeRe).join("|"), "gi"), "[term]");
  return out;
}
