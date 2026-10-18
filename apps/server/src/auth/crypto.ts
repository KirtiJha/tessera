import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function scrypt(password: string, salt: Buffer, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, len, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));
}

// Passwords: scrypt with per-user salt. No native dependency.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [alg, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password, salt, expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Random opaque token with a readable prefix: tsr_ devices, tss_ browser sessions, tse_ enrolment codes, tsi_ invites, tsk_ API keys. */
export function newToken(prefix: "tsr" | "tss" | "tse" | "tsi" | "tsk"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const encKey = createHash("sha256").update(`tessera-enc:${config.secret}`).digest();

/** AES-256-GCM for secrets at rest that the server must read back (webhook URLs). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encKey, iv);
  const out = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${out.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
}

export function decrypt(enc: string): string {
  const [v, ivB, dataB, tagB] = enc.split(".");
  if (v !== "v1" || !ivB || !dataB || !tagB) throw new Error("bad ciphertext");
  const d = createDecipheriv("aes-256-gcm", encKey, Buffer.from(ivB, "base64url"));
  d.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([d.update(Buffer.from(dataB, "base64url")), d.final()]).toString("utf8");
}

export function hmac(s: string): string {
  return createHmac("sha256", config.secret).update(s).digest("hex");
}
