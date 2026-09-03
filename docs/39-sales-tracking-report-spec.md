# S16 — รายงานติดตามการขาย (New vs Returning) — spec สำหรับ Codex

## เป้าหมาย
ให้ฝ่ายขายเห็นภาพรวมลูกค้า/ยอดขายแบบง่าย ๆ ใน Google Sheet: มีลูกค้ากี่คน · ใครใหม่ · **ใครเป็นลูกค้าเก่าที่กลับมาซื้อ** · สรุปยอด — แถวล่าสุดอยู่บนสุด ไว้ติดตามผลการขาย

**ไม่ใช่ database ใหม่** — เป็น "รายงาน/วิว" ที่ดึงจากข้อมูลที่มีอยู่แล้วมาสรุป

## นิยาม (ยึดตามนี้ให้ตรง)
- 🆕 **ลูกค้าใหม่** = ไม่มี `customer_links` ที่ `status:"confirmed"` (ไม่เคยเป็นลูกค้าเก่า)
- 🔁 **กลับมาซื้อ** = **มี** confirmed link กับ legacy (เคยซื้อ) **และ** มี purchase ใหม่ (partner) หลัง import
- **ยอดในรายงาน** = นับจาก `purchases` (partner) ที่ `status:"active"` เท่านั้น — **ห้ามเอา legacy payments มารวมยอด** (ประวัติเก่าเป็นแค่ "บริบท" แสดงว่าเคยจ่ายเท่าไร)
- **แถวล่าสุดอยู่บน** = เรียงตามวันซื้อ/เข้าใหม่ล่าสุด → เก่า

## สถาปัตยกรรม (กฎเดิม)
- **logic ใน core** `packages/core/src/sales/report.ts` (pure + เทส):
  - `buildSalesReport(input): SalesReport` — รับ customers + purchases(+items) + confirmedLinks + legacySummaryByPerson → คืน:
    - `rows: SalesRow[]` — `{ customerId, name, kind: "new"|"returning", customerStatus, lastActivityAt, newPurchaseTotal, newSeatCount, courses[], legacyContext?: { totalPaid, lastPaidAt } }` เรียงล่าสุดบน
    - `summary: { totalCustomers, newCount, returningCount, revenue, seatCount }`
  - reuse pattern การอ่าน legacy ผ่าน **confirmed links เท่านั้น** (D23) เหมือน `review/customerProfile.ts`
- **service** `packages/core/src/sales/service.ts` — `listSalesReport(mainDb, aiDb, legacyDb, range?)` ดึง batch แล้วเรียก core (เลียนแบบ `recommend/service.ts`)
- **Sheet output** — tab ใหม่ **"สรุปการขาย"**:
  - reuse ท่อ sheet เดิม (`customers/toSheetRow.ts` + `sheetQueue`) — เพิ่ม writer ชุดคอลัมน์ของรายงานนี้ (ชื่อ · ประเภท 🆕/🔁 · คอร์สที่ซื้อ · ยอดใหม่ · เคยจ่าย(เก่า) · วันล่าสุด)
  - แถวสรุป (รวม/ใหม่/กลับมา/ยอด) ไว้ด้านบน
  - อ่านอย่างเดียว (ระบบเขียน) — ฝ่ายขายดู ไม่ใช่แหล่งข้อมูลจริง

## Seed (ให้รายงานมีทั้ง new + returning ให้เห็น)
- ต่อ `scripts/seed-local.ts`: มีลูกค้าที่ **confirmed link + มี purchase ใหม่** (=🔁) อย่างน้อย 3 คน และลูกค้าใหม่ล้วน (=🆕) อีกชุด → รายงานโชว์ทั้งสองแบบ + summary ไม่ว่าง

## กติกา
- ยอดจาก purchases เท่านั้น (กันเบิ้ล — 1 บิลหลายคอร์สนับเงินครั้งเดียว) · legacy = บริบท ไม่รวมยอด
- D23: legacy ผ่าน confirmed links เท่านั้น
- logic ใน core + **เทส** (new/returning จำแนกถูก · ยอดไม่รวม legacy · เรียงล่าสุดบน · summary ตรง)
- ห้ามปิดเทสเดิม · ห้ามแตะ AI_HASH_PEPPER/INTERNAL_HMAC_SECRET
- ผ่าน `npm test` + `tsc --noEmit` + `next build`

## หมายเหตุ (ทีมเราจัดการเอง ไม่ใช่ Codex)
- **import legacy จริง 100–200 คนขึ้น Atlas** (`legacy:import` ชี้ Atlas) + `legacy:scrub` — ทีมรันตอน deploy · เป็น PII จริงบน cloud (dev cluster, สิทธิ์จำกัด) ตามที่ตัดสินแล้ว
- ลูกค้าใหม่จริงมาจากพนักงานกรอกผ่าน LIFF/FB lead form

## ส่งกลับให้ตรวจ
ไฟล์ที่แตะ · ผล seed:local (จำนวน new/returning ในรายงาน) · ผลเทส core sales · ผล test/build
