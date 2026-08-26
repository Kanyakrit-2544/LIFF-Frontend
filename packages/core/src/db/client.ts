import { MongoClient, type Db, type MongoClientOptions } from "mongodb";
import { env } from "../env";
import { log } from "../logger";

/**
 * บน serverless ทุก invocation อาจได้ process เดิม — ถ้าสร้าง MongoClient ใหม่ทุกครั้ง
 * connection pool จะพุ่งชน limit ของ Atlas (docs/06 §6.8)
 * จึง cache ไว้บน globalThis ซึ่งอยู่รอดข้าม invocation ใน container เดียวกัน
 */

declare global {
  // eslint-disable-next-line no-var
  var __lineCrmMongo: { client: MongoClient | null; promise: Promise<MongoClient> | null } | undefined;
}

const store = (globalThis.__lineCrmMongo ??= { client: null, promise: null });

function buildOptions(): MongoClientOptions {
  const { MONGODB_COMPRESSORS } = env("db");
  const compressors = MONGODB_COMPRESSORS.split(",")
    .map((c) => c.trim())
    .filter(Boolean) as MongoClientOptions["compressors"];

  return {
    // network compression: ลด bandwidth ระหว่าง Vercel ↔ Atlas
    // zstd อัตราบีบดีสุด, zlib เป็น fallback ที่มีใน Node เสมอ
    compressors,
    zlibCompressionLevel: 6,
    // serverless: pool เล็ก ปิดเร็ว
    maxPoolSize: 10,
    minPoolSize: 0,
    maxIdleTimeMS: 30_000,
    serverSelectionTimeoutMS: 8_000,
    socketTimeoutMS: 20_000,
    retryWrites: true,
    retryReads: true,
    appName: "line-crm",
  };
}

export async function getClient(): Promise<MongoClient> {
  if (store.client) return store.client;
  if (!store.promise) {
    const { MONGODB_URI } = env("db");
    store.promise = new MongoClient(MONGODB_URI, buildOptions())
      .connect()
      .then((c) => {
        store.client = c;
        log.info("mongo connected", { compressors: env("db").MONGODB_COMPRESSORS });
        return c;
      })
      .catch((e) => {
        store.promise = null; // ให้ลองใหม่ได้ ไม่ค้าง promise ที่ reject
        throw e;
      });
  }
  return store.promise;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db(env("db").MONGODB_DB);
}

export async function closeClient(): Promise<void> {
  if (store.client) {
    await store.client.close();
    store.client = null;
    store.promise = null;
  }
}

/** ใช้ใน /api/health — ต้องสะท้อนสถานะจริง ไม่ใช่ตอบ 200 ตลอด (docs/06 §6.10) */
export async function pingDb(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: (e as Error).message };
  }
}
