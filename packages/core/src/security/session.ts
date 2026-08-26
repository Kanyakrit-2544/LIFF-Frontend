import crypto from "node:crypto";
import { env } from "../env";

/**
 * Session cookie สำหรับ LIFF
 *
 * ทำไมต้องมี: verify id_token กับ LINE ใช้เวลา 100–200ms ต่อครั้ง
 * ถ้าทำทุก request หน้าฟอร์มจะอืดบนมือถือ 3G — verify ครั้งเดียวแล้วออก session สั้น ๆ แทน
 *
 * JWT HS256 เขียนเองเพราะต้องการแค่ sign/verify ไม่คุ้มที่จะเพิ่ม dependency
 */

const TTL_SECONDS = 30 * 60;

export interface SessionPayload {
  sub: string; // customerId ภายใน
  lineUserId: string;
  channelId: string;
  iat: number;
  exp: number;
}

const b64url = (b: Buffer) => b.toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

function sign(data: string, secret: string): string {
  return b64url(crypto.createHmac("sha256", secret).update(data).digest());
}

export function createSession(input: { customerId: string; lineUserId: string; channelId: string }, ttlSec = TTL_SECONDS): string {
  const secret = env("security").SESSION_JWT_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload: SessionPayload = { sub: input.customerId, lineUserId: input.lineUserId, channelId: input.channelId, iat: now, exp: now + ttlSec };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${header}.${body}.${sign(`${header}.${body}`, secret)}`;
}

export type SessionResult = { ok: true; payload: SessionPayload } | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" };

export function readSession(token: string | null | undefined): SessionResult {
  if (!token) return { ok: false, reason: "MALFORMED" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "MALFORMED" };
  const [h, b, sig] = parts as [string, string, string];

  // เทียบ signature เป็นสตริง base64url ทั้งคู่ (ไม่ decode) — timing-safe และเช็คความยาวก่อนไม่ให้ throw
  const expected = Buffer.from(sign(`${h}.${b}`, env("security").SESSION_JWT_SECRET));
  const received = Buffer.from(sig);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(fromB64url(b).toString("utf8")) as SessionPayload;
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (!payload?.sub || !payload.lineUserId) return { ok: false, reason: "MALFORMED" };
  if (payload.exp * 1000 <= Date.now()) return { ok: false, reason: "EXPIRED" };
  return { ok: true, payload };
}

export const SESSION_COOKIE = "liff_sess";

export function sessionCookieOptions(maxAgeSec = TTL_SECONDS) {
  return {
    httpOnly: true,        // JS ในหน้าเว็บอ่านไม่ได้ → XSS ขโมย session ไม่ได้
    secure: true,
    sameSite: "lax" as const,
    path: "/api",
    maxAge: maxAgeSec,
  };
}
