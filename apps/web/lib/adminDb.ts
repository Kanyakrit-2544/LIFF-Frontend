import { MongoClient, type Db } from "mongodb";

declare global {
  // eslint-disable-next-line no-var
  var __lineCrmAdminMongo: { client: MongoClient | null; promise: Promise<MongoClient> | null } | undefined;
}

const store = (globalThis.__lineCrmAdminMongo ??= { client: null, promise: null });

function required(name: "ADMIN_MONGODB_URI" | "AI_MONGODB_DB" | "LEGACY_MONGODB_DB"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_admin_env:${name}`);
  return value;
}

async function adminClient(): Promise<MongoClient> {
  if (store.client) return store.client;
  if (!store.promise) {
    store.promise = new MongoClient(required("ADMIN_MONGODB_URI"), {
      appName: "line-crm-admin-review",
      compressors: ["zstd", "zlib"],
      maxPoolSize: 5,
      minPoolSize: 0,
      maxIdleTimeMS: 30_000,
      serverSelectionTimeoutMS: 8_000,
      retryReads: true,
      retryWrites: true,
    }).connect().then((client) => {
      store.client = client;
      return client;
    }).catch((error) => {
      store.promise = null;
      throw error;
    });
  }
  return store.promise;
}

export async function getAdminReviewDbs(): Promise<{ aiDb: Db; legacyDb: Db }> {
  const client = await adminClient();
  const aiDb = client.db(required("AI_MONGODB_DB"));
  const legacyDb = client.db(required("LEGACY_MONGODB_DB"));
  await Promise.all([aiDb.command({ ping: 1 }), legacyDb.command({ ping: 1 })]);
  return { aiDb, legacyDb };
}

export async function getAdminAiDb(): Promise<Db> {
  const client = await adminClient();
  const db = client.db(required("AI_MONGODB_DB"));
  await db.command({ ping: 1 });
  return db;
}

export async function closeAdminClient(): Promise<void> {
  if (!store.client) return;
  await store.client.close();
  store.client = null;
  store.promise = null;
}
