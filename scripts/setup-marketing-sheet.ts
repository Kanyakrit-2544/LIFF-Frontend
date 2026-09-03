/** เตรียมชีตทีมการตลาดเท่านั้น ไม่แตะ GOOGLE_SHEET_ID ของฝ่ายขาย */
import {
  HEADERS,
  MARKETING_LEAD_HEADERS,
  MARKETING_POST_HEADERS,
  MARKETING_SHEET_TABS,
} from "../packages/core/src/index";
import { getAccessToken, loadServiceAccount, sheetsApi } from "./lib/googleAuth";

const SHEET_ID = process.env.GOOGLE_SHEET_ID_MARKETING ?? "";
const SA_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_FILE ?? "";
const definitions = [
  { title: MARKETING_SHEET_TABS.customers, headers: [...HEADERS] },
  { title: MARKETING_SHEET_TABS.leads, headers: [...MARKETING_LEAD_HEADERS] },
  { title: MARKETING_SHEET_TABS.posts, headers: [...MARKETING_POST_HEADERS] },
];

async function main(): Promise<void> {
  if (!SHEET_ID) throw new Error("ต้องตั้ง GOOGLE_SHEET_ID_MARKETING");
  if (!SA_PATH) throw new Error("ต้องตั้ง GOOGLE_SERVICE_ACCOUNT_FILE");
  const sa = loadServiceAccount(SA_PATH);
  const api = sheetsApi(await getAccessToken(sa), SHEET_ID);
  const meta = await api.meta() as {
    properties: { title: string };
    sheets: Array<{ properties: { sheetId: number; title: string } }>;
  };
  console.log(`ชีตการตลาด: ${meta.properties.title}`);
  const existing = new Map(meta.sheets.map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));
  const add = definitions.filter((tab) => !existing.has(tab.title)).map((tab) => ({
    addSheet: { properties: { title: tab.title } },
  }));
  if (add.length > 0) await api.batchUpdate(add);

  const current = await api.meta() as { sheets: Array<{ properties: { sheetId: number; title: string } }> };
  const sheetIds = new Map(current.sheets.map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));
  for (const tab of definitions) await api.updateValues(`'${tab.title}'!A1`, [tab.headers]);
  await api.batchUpdate(definitions.flatMap((tab) => {
    const sheetId = sheetIds.get(tab.title);
    if (sheetId === undefined) return [];
    return [
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
      { repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.95, blue: 0.95 } } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      } },
      { addProtectedRange: { protectedRange: {
        range: { sheetId },
        description: `${tab.title} — ระบบเขียน อ่านอย่างเดียว`,
        warningOnly: true,
      } } },
    ];
  })).catch((error) => console.log(`ตั้งรูปแบบบางส่วนไม่สำเร็จ: ${(error as Error).message.slice(0, 100)}`));
  console.log(`พร้อมใช้งาน ${definitions.length} แท็บ: ${definitions.map((tab) => tab.title).join(", ")}`);
}

main().catch((error) => {
  console.error("เตรียมชีตการตลาดไม่สำเร็จ:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
