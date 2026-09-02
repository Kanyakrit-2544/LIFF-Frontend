/**
 * ETL ข้อมูลลูกค้าเก่าของจริง จาก Inner.xlsx ลง MongoDB (ฐาน legacy)
 *
 *   npm run legacy:import -- --limit 30                    นำร่อง 30 แถวแรก
 *   npm run legacy:import -- --limit 30 --dry              ลองแกะเฉย ๆ ไม่เขียน DB
 *   npm run legacy:import -- --drop                        ล้างของจริงเดิมก่อน (ไม่แตะ synthetic)
 *   npm run legacy:import -- --sheets Inner2025,Inner2026  เลือกชีต
 *
 * ต่างจาก legacy:generate: อันนั้นปั้น synthetic, อันนี้อ่านของจริง (synthetic:false)
 * โครง doc ปลายทางตัวเดียวกันเป๊ะ → scrub/match/analytics ทำงานเหมือนกัน
 *
 * ⚠️ ไฟล์ต้นทางมี PII จริงที่ไม่ได้ผ่าน consent ผ่าน LIFF —
 *    ข้อมูลอยู่แค่ในฐาน legacy (สิทธิ์จำกัด) และถูก scrub ก่อนไป AI (scrubLegacy.ts)
 *    ห้าม log ค่าเซลล์ออกมา และห้าม commit ผลลัพธ์ลง repo
 */
import { execFileSync } from "node:child_process";
import { MongoClient } from "mongodb";
import { importLegacyRows, type ImportLegacySheetInput } from "../packages/core/src/legacy/importReal";
import { ensureLegacyIndexes } from "../packages/core/src/legacy/indexes";
import { LEGACY_COLLECTIONS, type LegacyImportRunDoc } from "../packages/core/src/legacy/models";
import { newId } from "../packages/core/src/ids";

function arg(name: string, fallback?: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) return process.argv[i + 1];
  return fallback;
}

interface ExtractOutput {
  source: string;
  sheets: ImportLegacySheetInput[];
}

async function main() {
  const file = arg("file", "raw input/Inner.xlsx")!;
  const sheets = arg("sheets", "Inner2025,Inner2026")!;
  const limit = arg("limit"); // undefined = ทั้งชีต
  const dry = process.argv.includes("--dry");
  const drop = process.argv.includes("--drop");

  console.log(`📖 อ่าน ${file} ชีต ${sheets}${limit ? ` (จำกัด ${limit} แถว)` : " (ทั้งหมด)"}`);

  const pyArgs = ["scripts/legacy/extract_rows.py", file, sheets];
  if (limit) pyArgs.push("--limit", limit);
  const raw = execFileSync("python3", pyArgs, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024, // เผื่อ full import (หลักหมื่นแถว + ที่อยู่ยาว)
  });
  const extracted = JSON.parse(raw) as ExtractOutput;

  const importRunId = newId("job");
  const startedAt = new Date();
  const result = importLegacyRows({ sheets: extracted.sheets, importRunId, now: startedAt });

  console.log(
    `   อ่าน ${result.rows} แถว → คน ${result.persons.length} · การชำระ ${result.payments.length} · รายการคอร์ส ${result.enrollments.length} · ข้าม ${result.skipped}`
  );
  const seats = result.enrollments.filter((e) => e.countsAsSeat).length;
  const revenue = result.payments.reduce((s, p) => s + (p.amount ?? 0), 0);
  console.log(`   ที่นั่งที่ขายได้ ${seats} · ยอดรวม (จาก payments) ${Math.round(revenue).toLocaleString("th-TH")} บาท`);
  if (result.unknownCourseHeaders.length) {
    console.warn(`⚠️  หัวคอลัมน์คอร์สที่พจนานุกรมไม่รู้จัก: ${result.unknownCourseHeaders.join(", ")} — เติมใน courses.ts`);
  }

  if (dry) {
    console.log("\n🔎 โหมด --dry: ไม่เขียน DB");
    return;
  }

  const uri = arg("uri", process.env.LEGACY_MONGODB_URI ?? process.env.MONGODB_URI);
  if (!uri) throw new Error("ไม่พบ URI — ใส่ --uri หรือตั้ง LEGACY_MONGODB_URI / MONGODB_URI");
  const dbName = arg("db", process.env.LEGACY_MONGODB_DB ?? "line_crm_legacy")!;

  const client = new MongoClient(uri, { appName: "line-crm-legacy-import", serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(dbName);
  console.log(`📦 database: ${dbName}`);

  try {
    if (drop) {
      for (const c of Object.values(LEGACY_COLLECTIONS)) {
        await db.collection(c).deleteMany({ synthetic: false }).catch(() => {});
      }
      console.log("🧹 ลบข้อมูลจริงเดิมแล้ว (synthetic ไม่ถูกแตะ)");
    }

    for (const r of await ensureLegacyIndexes(db)) console.log(`   index ${r.collection}: ${r.created.join(", ")}`);

    const chunk = 500;
    for (const [name, docs] of [
      [LEGACY_COLLECTIONS.persons, result.persons],
      [LEGACY_COLLECTIONS.payments, result.payments],
      [LEGACY_COLLECTIONS.enrollments, result.enrollments],
    ] as const) {
      for (let i = 0; i < docs.length; i += chunk) {
        if (docs.length === 0) break;
        await db.collection(name).insertMany(docs.slice(i, i + chunk) as never[], { ordered: false });
      }
      console.log(`   ↳ ${name}: ${docs.length}`);
    }

    const run: LegacyImportRunDoc = {
      _id: importRunId,
      mode: "real",
      sheets: extracted.sheets.map((s) => s.sheet),
      startedAt,
      finishedAt: new Date(),
      counts: {
        rows: result.rows,
        persons: result.persons.length,
        payments: result.payments.length,
        enrollments: result.enrollments.length,
        skipped: result.skipped,
      },
      unknownCourseHeaders: result.unknownCourseHeaders,
      notes: [
        `source=${file}`,
        limit ? `limit=${limit}` : "full",
        "ข้อมูลจริง มี PII — เข้าถึงจำกัด, scrub ก่อนไป AI",
      ],
    };
    await db.collection(LEGACY_COLLECTIONS.importRuns).insertOne(run as never);

    console.log("\n✅ เขียนลง DB เสร็จ");
    console.log(`   runId=${importRunId} · aiSync.dirty=true พร้อมให้ legacy:scrub ดึงต่อ`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error("❌", (e as Error).message);
  process.exit(1);
});
