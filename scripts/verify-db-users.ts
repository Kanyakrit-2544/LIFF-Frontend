/**
 * ตรวจสิทธิ์ MongoDB users สำหรับ S9 แบบรันมือ
 *
 * ตัวอย่าง:
 *   npm run verify:db-users -- \
 *     --app-uri "$MONGODB_URI" \
 *     --mirror-uri "$MONGODB_MIRROR_URI" \
 *     --ai-uri "$MONGODB_AI_URI" \
 *     --main-db line_crm_dev \
 *     --ai-db line_crm_ai
 *
 * ห้ามใส่ URI จริงในไฟล์นี้ และสคริปต์นี้จะไม่พิมพ์ URI ออก console
 */
import { MongoClient } from "mongodb";
import { AI_COLLECTIONS, COLLECTIONS } from "../packages/core/src/db/models";

type Check = { name: string; ok: boolean; detail?: string };

function arg(name: string, envKey?: string): string | null {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : null;
  return envKey ? process.env[envKey] ?? null : null;
}

function authDenied(e: unknown): boolean {
  const err = e as { code?: number; codeName?: string; message?: string };
  return err.code === 13 || err.codeName === "Unauthorized" || /not authorized|unauthorized/i.test(err.message ?? "");
}

async function expectAllowed(name: string, fn: () => Promise<unknown>): Promise<Check> {
  try {
    await fn();
    return { name, ok: true };
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message };
  }
}

async function expectDenied(name: string, fn: () => Promise<unknown>): Promise<Check> {
  try {
    await fn();
    return { name, ok: false, detail: "คำสั่งสำเร็จ ทั้งที่ควรถูกปฏิเสธ" };
  } catch (e) {
    if (authDenied(e)) return { name, ok: true };
    return { name, ok: false, detail: (e as Error).message };
  }
}

async function withClient<T>(uri: string, fn: (client: MongoClient) => Promise<T>): Promise<T> {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function main() {
  const appUri = arg("app-uri", "MONGODB_URI");
  const mirrorUri = arg("mirror-uri", "MONGODB_MIRROR_URI");
  const aiUri = arg("ai-uri", "MONGODB_AI_URI");
  const mainDb = arg("main-db") ?? "line_crm_dev";
  const aiDb = arg("ai-db", "MONGODB_AI_DB") ?? "line_crm_ai";

  const missing = [
    ["--app-uri", appUri],
    ["--mirror-uri", mirrorUri],
    ["--ai-uri", aiUri],
  ].filter(([, v]) => !v);
  if (missing.length) {
    console.error("❌ ต้องส่งค่า URI ให้ครบ:");
    for (const [name] of missing) console.error(`   ${name}`);
    process.exit(2);
  }

  const verifyId = `verify_s9_${Date.now()}`;
  const checks: Check[] = [];

  await withClient(appUri!, async (client) => {
    checks.push(await expectAllowed("app_user อ่าน line_crm_dev.customers ได้", () =>
      client.db(mainDb).collection(COLLECTIONS.customers).findOne({})
    ));
    checks.push(await expectDenied("app_user อ่าน line_crm_ai.customers_scrubbed ไม่ได้", () =>
      client.db(aiDb).collection(AI_COLLECTIONS.customersScrubbed).findOne({})
    ));
  });

  await withClient(mirrorUri!, async (client) => {
    checks.push(await expectDenied("mirror_user อ่าน line_crm_dev.customers ไม่ได้", () =>
      client.db(mainDb).collection(COLLECTIONS.customers).findOne({})
    ));
    checks.push(await expectAllowed("mirror_user เขียน line_crm_ai.customers_scrubbed ได้", async () => {
      await client.db(aiDb).collection(AI_COLLECTIONS.customersScrubbed).updateOne(
        { _id: verifyId },
        { $set: { _id: verifyId, status: "verify", syncedAt: new Date().toISOString() } },
        { upsert: true }
      );
      await client.db(aiDb).collection(AI_COLLECTIONS.customersScrubbed).deleteOne({ _id: verifyId });
    }));
  });

  await withClient(aiUri!, async (client) => {
    checks.push(await expectDenied("ai_user อ่าน line_crm_dev.customers ไม่ได้", () =>
      client.db(mainDb).collection(COLLECTIONS.customers).findOne({})
    ));
    checks.push(await expectAllowed("ai_user อ่าน line_crm_ai.customers_scrubbed ได้", () =>
      client.db(aiDb).collection(AI_COLLECTIONS.customersScrubbed).findOne({})
    ));
    checks.push(await expectDenied("ai_user เขียน line_crm_ai.customers_scrubbed ไม่ได้", async () => {
      const id = `${verifyId}_deny`;
      await client.db(aiDb).collection(AI_COLLECTIONS.customersScrubbed).insertOne({ _id: id });
      await client.db(aiDb).collection(AI_COLLECTIONS.customersScrubbed).deleteOne({ _id: id });
    }));
  });

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }

  if (failed.length > 0) {
    process.exitCode = 1;
    console.error(`\n❌ ไม่ผ่าน ${failed.length}/${checks.length} ข้อ`);
  } else {
    console.log(`\n✅ ผ่านครบ ${checks.length} ข้อ`);
  }
}

main().catch((e) => {
  console.error("❌ ตรวจสิทธิ์ DB user ไม่สำเร็จ:", (e as Error).message);
  process.exitCode = 1;
});
