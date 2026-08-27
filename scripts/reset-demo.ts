/**
 * ล้างข้อมูลลูกค้าเพื่อทดสอบใหม่
 *
 *   npm run reset:demo            ลบลูกค้าทั้งหมด → กรอกฟอร์มใหม่ = ลูกค้าใหม่
 *   npm run reset:demo -- --resync  ไม่ลบ แค่สั่งให้ sync ขึ้นชีต/AI ใหม่ทั้งหมด
 *
 * ⚠️ ไม่แตะ form_schemas (ตัวแบบฟอร์ม ลบแล้ว LIFF พัง)
 */
import { getDb, closeClient, COLLECTIONS } from "../packages/core/src/index";

const resync = process.argv.includes("--resync");

async function main() {
  const db = await getDb();
  const cust = db.collection(COLLECTIONS.customers);

  if (resync) {
    const r = await cust.updateMany({}, {
      $set: { "sheetSync.dirty": true, "sheetSync.lockedAt": null, "sheetSync.attempts": 0,
              "aiSync.dirty": true, "aiSync.lockedAt": null, "aiSync.attempts": 0 },
    });
    console.log(`🔄 สั่ง sync ใหม่ ${r.modifiedCount} คน — รอ WF-C 2 นาที / WF-D 10 นาที`);
    return;
  }

  const n = await cust.countDocuments();
  const ids = (await cust.find({}, { projection: { _id: 1 } }).toArray()).map((c) => c._id);
  for (const [name, filter] of [
    [COLLECTIONS.customerProfiles, { customerId: { $in: ids } }],
    [COLLECTIONS.interactions, { customerId: { $in: ids } }],
    [COLLECTIONS.identities, { customerId: { $in: ids } }],
    [COLLECTIONS.customers, {}],
    [COLLECTIONS.inboundEvents, {}],
    [COLLECTIONS.auditLogs, {}],
  ] as const) {
    const r = await db.collection(name as string).deleteMany(filter as never);
    if (r.deletedCount) console.log(`  ลบ ${name}: ${r.deletedCount}`);
  }
  console.log(`\n🗑  ลบลูกค้า ${n} คนแล้ว · form_schemas ยังอยู่ครบ`);
  console.log("👉 ลบแถวในชีตด้วยมือ (แถว 2 ลงไป เก็บหัวตารางไว้) แล้วกรอกฟอร์มใหม่ได้เลย");
}

main().catch((e) => { console.error("❌", (e as Error).message); process.exitCode = 1; })
  .finally(() => closeClient());
