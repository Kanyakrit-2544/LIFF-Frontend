# S18 — แท็บ Intent (Tagger) ในชีตทีมขาย — spec สำหรับ Codex

## เป้าหมาย
ให้ฝ่ายขายเห็น "ใครสนใจ/ลังเลคอร์สอะไร ณ ตอนนี้" ใน Google Sheet ไว้ตามผล — เป็น snapshot ปัจจุบัน (เหมือนแท็บ `สรุปการขาย` ของ S16) เสริมหน้า "โอกาสการขาย" ที่มีอยู่

## ที่วาง
- **ชีตทีมขาย** (`GOOGLE_SHEET_ID` เดิม) → เพิ่มแท็บใหม่ **`Intent`**
  (ชีตขายตอนนี้มี `Customers` + `สรุปการขาย` → เพิ่ม `Intent` เป็นตัวที่สาม)
- ไม่แตะชีตการตลาด (S17) และไม่แตะ logic ของ `สรุปการขาย`/`Customers` เดิม

## ข้อมูลที่แสดง (snapshot ปัจจุบันเท่านั้น)
- เอาเฉพาะ **intent ปัจจุบัน** — ไม่ `voidedAt`, ไม่ `supersededAt` (reuse `currentIntent`/`recomputeIntentCurrent` ที่มีใน `partner/intents.ts`)
- คอลัมน์: `ชื่อลูกค้า · คอร์ส · สถานะ(สนใจ/ลังเล/ไม่สนใจ) · เหตุผลลังเล · ความมั่นใจ % · ที่มา(AI/พนักงาน) · วันที่พบล่าสุด`
- เรียง **ล่าสุดอยู่บน** (ตาม observedAt)
- แถวสรุปด้านบน: `สนใจ N · ลังเล N · ไม่สนใจ N`
- **ห้ามมีข้อความแชท** (D4/PDPA) — เอาแค่ผลวิเคราะห์
- ลูกค้า `status:"erased"` → ซ่อนชื่อ (เหมือนที่อื่น)

## สถาปัตยกรรม (ตาม S16 เป๊ะ)
- **core** `packages/core/src/sales/intentSheet.ts` (หรือรวมใน sales ที่มี):
  - `buildIntentSheetRows(intents, customersById): SheetCell[][]` — pure + เทส
  - นิยาม INTENT_SHEET_TAB = "Intent" + headers
- **route** `/api/internal/sheets/pending` (ตัวเดิมของชีตขาย) — เพิ่ม `intentReport` ใน payload คู่กับ `salesReport` (แบบเดียวกัน)
- **WF-C** — เพิ่ม clear+write แท็บ `Intent` (แบบเดียวกับ `สรุปการขาย`: clear `Intent!A:G` แล้วเขียนทับ) ใน 배치เดียวกัน · **ต้องไม่กระทบแท็บอื่น**

## Seed
- seed-local มี customer_intents อยู่แล้ว (สนใจ/ลังเล) → แท็บ Intent ต้องมีของโชว์ · เพิ่มให้ครบทั้ง 3 สถานะถ้ายังขาด

## กติกา
- logic ใน core + **เทส** (เอาเฉพาะ current, เรียงล่าสุดบน, summary ตรง, erased ซ่อนชื่อ, ไม่มีแชท)
- ห้ามแตะ logic `สรุปการขาย`/`Customers`/ชีตการตลาด · ห้ามปิดเทสเดิม
- ห้ามแตะ `AI_HASH_PEPPER`/`INTERNAL_HMAC_SECRET` · URI local เติม `/?directConnection=true`
- ผ่าน `npm test` + `tsc --noEmit` + `next build`

## ส่งกลับ
ไฟล์ที่แตะ · ผล seed:local (จำนวนแต่ละสถานะในแท็บ Intent) · ผลเทส · ผล test/build
