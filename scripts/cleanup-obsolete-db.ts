/**
 * ลบ collection เก่าที่โค้ดปัจจุบันไม่ได้ใช้งานแล้ว
 *
 * ค่าเริ่มต้นเป็น dry-run เพื่อไม่ให้ลบข้อมูลจริงโดยไม่ตั้งใจ:
 *   npm run cleanup:db-obsolete
 *   npm run cleanup:db-obsolete -- --apply
 */
import { getDb, closeClient } from "../packages/core/src/db/client";

const OBSOLETE_COLLECTIONS = ["pii_tokens", "integrations"];

async function main() {
  const apply = process.argv.includes("--apply");
  const db = await getDb();
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  console.log(apply ? "โหมดลบจริง" : "โหมดตรวจอย่างเดียว (--apply เพื่อให้ลบจริง)");
  for (const name of OBSOLETE_COLLECTIONS) {
    if (!existing.has(name)) {
      console.log(`• ${name}: ไม่มีอยู่แล้ว`);
      continue;
    }

    const count = await db.collection(name).estimatedDocumentCount();
    if (apply) {
      await db.collection(name).drop();
      console.log(`− ${name}: ลบแล้ว (${count} docs)`);
    } else {
      console.log(`• ${name}: จะลบได้ (${count} docs)`);
    }
  }
}

main()
  .catch((e) => {
    console.error("ลบ collection เก่าไม่สำเร็จ:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeClient());
