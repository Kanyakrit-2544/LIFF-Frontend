/**
 * สร้าง collection (พร้อม block compressor) + index ทั้งหมด
 * รันซ้ำได้ปลอดภัย — ต้องรันก่อนขึ้น production ทุกครั้ง (docs/06 §6.8)
 *
 *   npm run create-indexes            สร้าง/อัปเดต
 *   npm run create-indexes -- --verify  ตรวจอย่างเดียว ไม่แก้อะไร
 */
import { getDb, closeClient } from "../packages/core/src/db/client";
import { ensureIndexes, verifyIndexes } from "../packages/core/src/db/indexes";
import { env } from "../packages/core/src/env";

const verifyOnly = process.argv.includes("--verify");

async function main() {
  const db = await getDb();
  console.log(`📦 database: ${env("db").MONGODB_DB}`);
  console.log(`🗜  network compressors: ${env("db").MONGODB_COMPRESSORS}`);
  console.log(`🗜  block compressor:    ${env("db").MONGODB_BLOCK_COMPRESSOR}\n`);

  if (!verifyOnly) {
    for (const r of await ensureIndexes(db)) {
      const mark = r.collectionState === "exists" ? "•" : r.collectionState === "created" ? "✚" : "✚(default)";
      console.log(`${mark} ${r.collection.padEnd(20)} index: ${r.indexesCreated.length}`);
    }
    console.log("");
  }

  const v = await verifyIndexes(db);
  if (v.ok) {
    console.log("✅ index ครบทุกตัว");
  } else {
    console.error("❌ index ที่ยังขาด:");
    for (const m of v.missing) console.error(`   - ${m}`);
    process.exitCode = 1;
  }

  // รายงานผลการบีบอัดจริงต่อ collection
  console.log("\n📊 ขนาดจริงบนดิสก์:");
  for (const name of (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort()) {
    try {
      const s = (await db.command({ collStats: name })) as {
        count?: number;
        size?: number;
        storageSize?: number;
        wiredTiger?: { creationString?: string };
      };
      const compressor = s.wiredTiger?.creationString?.match(/block_compressor=(\w+)/)?.[1] ?? "?";
      const logical = s.size ?? 0;
      const disk = s.storageSize ?? 0;
      const ratio = logical > 0 && disk > 0 ? `${(logical / disk).toFixed(2)}x` : "-";
      console.log(
        `   ${name.padEnd(20)} docs=${String(s.count ?? 0).padStart(7)}  ` +
          `logical=${(logical / 1024).toFixed(1)}KB  disk=${(disk / 1024).toFixed(1)}KB  ` +
          `ratio=${ratio}  compressor=${compressor}`
      );
    } catch {
      console.log(`   ${name.padEnd(20)} (อ่าน collStats ไม่ได้ — shared tier อาจไม่อนุญาต)`);
    }
  }
}

main()
  .catch((e) => {
    console.error("\n❌ ล้มเหลว:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeClient());
