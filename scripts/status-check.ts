import { checkSystemStatus, closeClient } from "@line-crm/core";

async function main(): Promise<void> {
  const status = await checkSystemStatus({ persist: true });
  console.log(status.ok ? "✅ ระบบปกติ — ไม่พบข้อมูลค้าง" : `⚠️ พบปัญหา ${status.issues.length} รายการ`);
  for (const issue of status.issues) {
    console.log(`- [${issue.severity}] ${issue.title}: ${issue.detail}${issue.ageMinutes === null ? "" : ` (${issue.ageMinutes} นาที)`}`);
  }
  if (status.incidentUpdate) {
    console.log(`รายงานใหม่ ${status.incidentUpdate.newlyReported.length} · ยังเปิดอยู่ ${status.incidentUpdate.stillOpen.length} · หายแล้ว ${status.incidentUpdate.resolved.length}`);
  }
  if (!status.ok) process.exitCode = 2;
}

main().catch((error) => {
  console.error("ตรวจสถานะไม่สำเร็จ:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => closeClient());
