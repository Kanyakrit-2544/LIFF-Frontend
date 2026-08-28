/**
 * ปั้นฐาน legacy แบบ synthetic ลง MongoDB
 *
 *   npm run legacy:generate -- --uri "mongodb://localhost:27018" --db line_crm_legacy
 *   npm run legacy:generate -- --scale 0.1 --seed 42       ชุดเล็กไว้ลองเร็ว ๆ
 *   npm run legacy:generate -- --drop                      ล้างของเดิมก่อน
 *
 * ค่าเริ่มต้นอ่านจาก LEGACY_MONGODB_URI แล้วค่อย MONGODB_URI
 * ข้อมูลที่ได้เป็นของปั้นทั้งหมด (synthetic: true) — ห้ามเอาตัวเลขไปใช้ตัดสินใจทางธุรกิจ
 */
import { readFileSync } from "node:fs";
import { MongoClient } from "mongodb";
import { generateLegacy } from "../packages/core/src/legacy/generate";
import { ensureLegacyIndexes } from "../packages/core/src/legacy/indexes";
import { LEGACY_COLLECTIONS, type LegacyImportRunDoc } from "../packages/core/src/legacy/models";
import { legacyProfileSchema } from "../packages/core/src/legacy/profile";
import { newId } from "../packages/core/src/ids";

function arg(name: string, fallback?: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) return process.argv[i + 1];
  return fallback;
}

const PROFILE_PATH = new URL("../packages/core/src/legacy/profile.json", import.meta.url);

async function main() {
  const uri = arg("uri", process.env.LEGACY_MONGODB_URI ?? process.env.MONGODB_URI);
  if (!uri) throw new Error("ไม่พบ URI — ใส่ --uri หรือตั้ง LEGACY_MONGODB_URI / MONGODB_URI");
  const dbName = arg("db", process.env.LEGACY_MONGODB_DB ?? "line_crm_legacy")!;
  const seed = Number(arg("seed", "20260828"));
  const scale = Number(arg("scale", "1"));
  const drop = process.argv.includes("--drop");

  const profile = legacyProfileSchema.parse(JSON.parse(readFileSync(PROFILE_PATH, "utf8")));
  const importRunId = newId("job");
  const startedAt = new Date();

  console.log(`🎲 ปั้นข้อมูล synthetic จาก profile ของ ${profile.source} (${profile.sheets.map((s) => s.sheet).join(", ")})`);
  console.log(`   seed=${seed} scale=${scale} runId=${importRunId}`);

  const data = generateLegacy({ profile, importRunId, seed, scale, now: startedAt });
  console.log(`   คน ${data.persons.length} · การชำระ ${data.payments.length} · ที่นั่ง/รายการคอร์ส ${data.enrollments.length}`);
  if (data.unknownCourseHeaders.length) {
    console.warn(`⚠️  หัวคอลัมน์ที่พจนานุกรมไม่รู้จัก: ${data.unknownCourseHeaders.join(", ")}`);
  }

  const client = new MongoClient(uri, { appName: "line-crm-legacy-gen", serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(dbName);
  console.log(`📦 database: ${dbName}`);

  try {
    if (drop) {
      for (const c of Object.values(LEGACY_COLLECTIONS)) await db.collection(c).deleteMany({ synthetic: true }).catch(() => {});
      console.log("🧹 ลบข้อมูล synthetic เดิมแล้ว (ของจริงถ้ามีจะไม่ถูกแตะ)");
    }

    for (const r of await ensureLegacyIndexes(db)) console.log(`   index ${r.collection}: ${r.created.join(", ")}`);

    const chunk = 500;
    for (const [name, docs] of [
      [LEGACY_COLLECTIONS.persons, data.persons],
      [LEGACY_COLLECTIONS.payments, data.payments],
      [LEGACY_COLLECTIONS.enrollments, data.enrollments],
    ] as const) {
      for (let i = 0; i < docs.length; i += chunk) {
        await db.collection(name).insertMany(docs.slice(i, i + chunk) as never[], { ordered: false });
      }
      console.log(`   ↳ ${name}: ${docs.length}`);
    }

    const run: LegacyImportRunDoc = {
      _id: importRunId,
      mode: "synthetic",
      sheets: profile.sheets.map((s) => s.sheet),
      startedAt,
      finishedAt: new Date(),
      counts: {
        rows: data.payments.length,
        persons: data.persons.length,
        payments: data.payments.length,
        enrollments: data.enrollments.length,
        skipped: 0,
      },
      unknownCourseHeaders: data.unknownCourseHeaders,
      notes: [`seed=${seed}`, `scale=${scale}`, "ข้อมูลปั้นทั้งหมด ห้ามใช้ตัดสินใจทางธุรกิจ"],
    };
    await db.collection(LEGACY_COLLECTIONS.importRuns).insertOne(run as never);

    const seats = await db.collection(LEGACY_COLLECTIONS.enrollments).countDocuments({ countsAsSeat: true });
    const revenue = await db
      .collection(LEGACY_COLLECTIONS.payments)
      .aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }])
      .toArray();
    console.log("\n✅ เสร็จ");
    console.log(`   ที่นั่งที่ขายได้จริง ${seats} จากรายการคอร์สทั้งหมด ${data.enrollments.length}`);
    console.log(`   ยอดรวม (จาก payments เท่านั้น) ${Math.round(revenue[0]?.total ?? 0).toLocaleString("th-TH")} บาท`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error("❌", (e as Error).message);
  process.exit(1);
});
