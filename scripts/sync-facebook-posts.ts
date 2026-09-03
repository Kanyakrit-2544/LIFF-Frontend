import {
  closeClient,
  createFacebookGraphClient,
  getDb,
  syncFacebookPosts,
} from "../packages/core/src/index";

function daysArg(): number | undefined {
  const equals = process.argv.find((value) => value.startsWith("--days="));
  const index = process.argv.indexOf("--days");
  const raw = equals?.slice("--days=".length) ?? (index >= 0 ? process.argv[index + 1] : undefined);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 366) {
    throw new Error("--days ต้องเป็นจำนวนเต็ม 1–366");
  }
  return value;
}

async function main(): Promise<void> {
  const client = createFacebookGraphClient();
  if (!client) {
    console.log("Facebook posts ปิดอยู่: ยังไม่ได้ตั้ง FACEBOOK_PAGE_TOKEN/FACEBOOK_PAGE_ID");
    return;
  }
  const result = await syncFacebookPosts(await getDb(), client, { days: daysArg() });
  console.log([
    `Facebook posts ย้อนหลัง ${result.days} วัน`,
    `ดึง ${result.fetched}`,
    `บันทึก ${result.stored}`,
    `ข้อมูลไม่ครบ ${result.invalid}`,
    `insights พลาด ${result.insightFailures}`,
    `attribute สำเร็จ ${result.attribution.resolved}`,
    `ยัง resolve ไม่ได้ ${result.attribution.unresolved}`,
  ].join(" | "));
}

main()
  .catch((error) => {
    console.error("ดึง Facebook posts ไม่สำเร็จ:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  })
  .finally(closeClient);
