import { MongoClient, type Db } from "mongodb";

/**
 * connection ไป line_crm_ai ด้วย mirror_user (เขียนได้เฉพาะ line_crm_ai)
 * ใช้โดย endpoint ที่ต้อง scrub/match — แยกจาก app_user (line_crm_dev) และ review_user
 * cache บน globalThis แบบเดียวกับ client หลัก กัน pool พุ่งบน serverless
 */
declare global {
  // eslint-disable-next-line no-var
  var __lineCrmMirrorMongo: { client: MongoClient | null; promise: Promise<MongoClient> | null } | undefined;
}
const store = (globalThis.__lineCrmMirrorMongo ??= { client: null, promise: null });

export function mirrorConfigured(): boolean {
  return Boolean(process.env.MONGODB_MIRROR_URI?.trim());
}

async function client(): Promise<MongoClient> {
  if (store.client) return store.client;
  const uri = process.env.MONGODB_MIRROR_URI?.trim();
  if (!uri) throw new Error("missing_env:MONGODB_MIRROR_URI");
  if (!store.promise) {
    store.promise = new MongoClient(uri, {
      appName: "line-crm-mirror", compressors: ["zstd", "zlib"],
      maxPoolSize: 5, minPoolSize: 0, maxIdleTimeMS: 30_000,
      serverSelectionTimeoutMS: 8_000, retryReads: true, retryWrites: true,
    }).connect().then((c) => { store.client = c; return c; })
      .catch((e) => { store.promise = null; throw e; });
  }
  return store.promise;
}

export async function getMirrorAiDb(): Promise<Db> {
  return (await client()).db(process.env.AI_MONGODB_DB?.trim() || "line_crm_ai");
}
