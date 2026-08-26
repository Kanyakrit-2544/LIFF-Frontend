import { NextResponse } from "next/server";
import { newId } from "@line-crm/core";

export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "INTERNAL_ERROR";

const STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  INTERNAL_ERROR: 500,
};

export function newRequestId(): string {
  return newId("job");
}

export function ok<T extends Record<string, unknown>>(data: T, requestId: string, status = 200) {
  return NextResponse.json({ ok: true, ...data, requestId }, { status });
}

/**
 * error envelope มาตรฐาน (docs/03 §3.1)
 * ⚠️ ห้ามใส่ stack trace / ชื่อ collection / connection string ลงใน message ที่ส่งกลับ client
 */
export function fail(code: ErrorCode, message: string, requestId: string, details?: unknown) {
  return NextResponse.json(
    { ok: false, error: { code, message, ...(details ? { details } : {}) }, requestId },
    { status: STATUS[code] }
  );
}
