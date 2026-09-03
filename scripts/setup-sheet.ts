/**
 * เตรียม Google Sheet ให้พร้อมรับข้อมูล — รันครั้งเดียว (รันซ้ำได้ปลอดภัย)
 *
 *   npm run setup:sheet
 *
 * สร้าง/อัปเดตแท็บ Customers และสรุปการขาย, ลบแท็บเก่าที่ไม่ได้ใช้, เขียนหัวตารางและป้องกันช่วงระบบ
 */
import { HEADERS, SYSTEM_COLUMNS, columnLetter } from "../packages/core/src/customers/toSheetRow";
import { SALES_SHEET_HEADERS, SALES_SHEET_TAB } from "../packages/core/src/sales/report";
import { getAccessToken, loadServiceAccount, sheetsApi } from "./lib/googleAuth";

const SHEET_ID = process.env.GOOGLE_SHEET_ID ?? "";
const SA_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_FILE ?? "";
const DATA_TAB = "Customers";
const OBSOLETE_TABS = ["_Log", "_Schema"];

async function main() {
  if (!SHEET_ID) throw new Error("ต้องตั้ง GOOGLE_SHEET_ID");
  if (!SA_PATH) throw new Error("ต้องตั้ง GOOGLE_SERVICE_ACCOUNT_FILE (path ไปยังไฟล์ JSON)");

  const sa = loadServiceAccount(SA_PATH);
  const api = sheetsApi(await getAccessToken(sa), SHEET_ID);
  const meta = (await api.meta()) as { properties: { title: string }; sheets: { properties: { sheetId: number; title: string } }[] };

  console.log(`📄 ${meta.properties.title}`);
  console.log(`   service account: ${sa.client_email}\n`);

  const existing = new Map(meta.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
  const requests: unknown[] = [];
  for (const title of [DATA_TAB, SALES_SHEET_TAB]) {
    if (!existing.has(title)) {
      requests.push({ addSheet: { properties: { title } } });
      console.log(`✚ สร้างแท็บ ${title}`);
    } else {
      console.log(`• แท็บ ${title} มีอยู่แล้ว`);
    }
  }
  if (requests.length > 0) await api.batchUpdate(requests);

  let after = (await api.meta()) as { sheets: { properties: { sheetId: number; title: string } }[] };
  const cleanup = after.sheets
    .filter((s) => OBSOLETE_TABS.includes(s.properties.title))
    .map((s) => ({ deleteSheet: { sheetId: s.properties.sheetId } }));
  if (cleanup.length > 0) {
    await api.batchUpdate(cleanup);
    for (const title of after.sheets.map((s) => s.properties.title).filter((t) => OBSOLETE_TABS.includes(t))) {
      console.log(`− ลบแท็บเก่า ${title}`);
    }
    after = (await api.meta()) as { sheets: { properties: { sheetId: number; title: string } }[] };
  }
  const dataId = after.sheets.find((s) => s.properties.title === DATA_TAB)!.properties.sheetId;
  const salesId = after.sheets.find((s) => s.properties.title === SALES_SHEET_TAB)!.properties.sheetId;

  // หัวตาราง — เขียนทับทุกครั้งเพื่อให้ตรงกับ SHEET_COLUMNS เสมอ
  const lastCol = columnLetter(HEADERS.length - 1);
  await api.updateValues(`${DATA_TAB}!A1:${lastCol}1`, [HEADERS]);
  await api.updateValues(`${SALES_SHEET_TAB}!A1:F2`, [
    ["สรุป", "ลูกค้ารวม 0 คน", "🆕 ใหม่ 0 คน", "🔁 กลับมาซื้อ 0 คน", "ยอดใหม่ 0 บาท", "ที่นั่ง 0"],
    [...SALES_SHEET_HEADERS],
  ]);
  console.log(`\n✚ หัวตาราง ${HEADERS.length} คอลัมน์ (A–${lastCol})`);
  console.log(`   ระบบเขียน A–${columnLetter(SYSTEM_COLUMNS.length - 1)} · พนักงานกรอก ${lastCol}`);
  console.log(`✚ แท็บ ${SALES_SHEET_TAB} ${SALES_SHEET_HEADERS.length} คอลัมน์ (ระบบเขียนทั้งหมด)`);

  await api.batchUpdate([
    { updateSheetProperties: { properties: { sheetId: dataId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
    { repeatCell: {
        range: { sheetId: dataId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.95, blue: 0.95 } } },
        fields: "userEnteredFormat(textFormat,backgroundColor)" } },
    // ล็อกคอลัมน์ A ไม่ให้พนักงานเผลอลบ customerId ซึ่งเป็นกุญแจหาแถว
    { addProtectedRange: { protectedRange: {
        range: { sheetId: dataId, startColumnIndex: 0, endColumnIndex: 1 },
        description: "customerId — ระบบใช้หาแถว ห้ามแก้", warningOnly: true } } },
    { updateSheetProperties: { properties: { sheetId: salesId, gridProperties: { frozenRowCount: 2 } }, fields: "gridProperties.frozenRowCount" } },
    { repeatCell: {
        range: { sheetId: salesId, startRowIndex: 0, endRowIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.95, blue: 0.95 } } },
        fields: "userEnteredFormat(textFormat,backgroundColor)" } },
    { addProtectedRange: { protectedRange: {
        range: { sheetId: salesId },
        description: "รายงานสรุปการขาย — ระบบเขียน อ่านอย่างเดียว", warningOnly: true } } },
  ]).catch((e) => console.log(`   (ตั้งรูปแบบบางส่วนไม่สำเร็จ: ${(e as Error).message.slice(0, 80)})`));

  console.log("\nคอลัมน์:");
  HEADERS.forEach((h, i) => console.log(`   ${columnLetter(i).padEnd(3)} ${h}`));
  console.log(`\n✅ พร้อมรับข้อมูลแล้ว`);
}

main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exitCode = 1; });
