import { pingDb, queueStats, env, log } from "@line-crm/core";
import { newRequestId } from "@/lib/http";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 * ⚠️ ต้องสะท้อนสถานะจริง — ตอบ 200 ตลอดเวลาแม้ Mongo ล่ม จะทำให้ monitoring ไร้ประโยชน์ (docs/06 §6.10)
 */
export async function GET() {
  const requestId = newRequestId();
  const db = await pingDb();

  let queue: Record<string, number> | null = null;
  if (db.ok) {
    try {
      queue = await queueStats();
    } catch (e) {
      log.warn("อ่าน queue stats ไม่ได้", { requestId, error: (e as Error).message });
    }
  }

  const body = {
    ok: db.ok,
    requestId,
    at: new Date().toISOString(),
    db: { ok: db.ok, latencyMs: db.latencyMs, ...(db.error ? { error: "เชื่อมต่อฐานข้อมูลไม่ได้" } : {}) },
    ...(queue ? { queue, deadCount: queue.dead ?? 0 } : {}),
    config: {
      dbName: safe(() => env("db").MONGODB_DB),
      compressors: safe(() => env("db").MONGODB_COMPRESSORS),
      n8nPush: safe(() => env("n8n").N8N_PUSH_ENABLED),
      sheetsPiiMode: safe(() => env("sheets").SHEETS_PII_MODE),
    },
  };

  return NextResponse.json(body, { status: db.ok ? 200 : 503 });
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
