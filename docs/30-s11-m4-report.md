# S11-M4 — Analytics + insights · ผลการทำงานจริง

วันที่: 2026-08-28 · ทำโดยผู้ทำ = ผู้รีวิว (ไม่ได้ส่งให้ Codex)

## สิ่งที่ทำ

| ส่วน | ไฟล์ |
|---|---|
| §3.1 ส่ง `leadAttribution` เข้า AI DB | `packages/core/src/ai/scrubCustomer.ts` |
| §3.2 อัปเดต WF-D | `workflows/WF-D-ai-mirror.json` — import โดยผูก credential ไว้ในไฟล์ก่อน |
| query schema + ตัวคิดเวลาไทย | `packages/core/src/analytics/query.ts` |
| aggregation ทั้ง 6 metric | `packages/core/src/analytics/aggregate.ts` |
| ตัวกันโกหก | `packages/core/src/analytics/verify.ts` |
| ชั้น LLM (แปลงคำถาม + เขียนสรุป) | `packages/core/src/analytics/ask.ts` |
| `insights` collection | `packages/core/src/analytics/insights.ts` |
| CLI | `scripts/ask-insights.ts` · `npm run insights:ask` |

## ผลรันจริง

```text
RUN_MONGO_INTEGRATION=true npm test
core 292 passed (33 files) · web 64 passed (6 files) · skipped 0
   (ก่อน M4: core 253 · web 64 → เพิ่ม 39 เทส)

npm run typecheck   ผ่านทั้ง core / web / scripts
```

### ยืนยัน D37 — ข้อมูลจำลองไม่โผล่โดยไม่ได้ขอ

ฐาน legacy ทั้งก้อนเป็น synthetic · ถามด้วยค่าเริ่มต้น

```text
📊 seats · 2025-01-01 ถึง 2025-12-31 (Asia/Bangkok)
   รวม            0
   (สแกน 0 แถว)
   ⚠️  ไม่รวมข้อมูลจำลอง (includeSynthetic: false)
```

ขอเข้ามาถึงจะโผล่ พร้อมป้ายเตือนทุกครั้ง

```text
📊 seats · 2025-01-01 ถึง 2025-12-31
   Inner Makeover     458 (44.68%)
   Communication      274 (26.73%)
   Presentation       167 (16.29%)
   Deep In             70 (6.83%)
   Inner Camp          33 (3.22%)
   The Trainer         23 (2.24%)
   รวม              1,025
   ⚠️  ผลนี้มีข้อมูลจำลองปนอยู่ ห้ามนำไปใช้ตัดสินใจทางธุรกิจ
```

### ตรวจสอบความถูกต้องของยอดเงิน

```text
📊 revenue · 2025-01-01 ถึง 2025-12-31 · groupBy month
   รวม   36,306,490
```

**ตรงกับตัวเลขที่คำนวณด้วย mongosh ตอน M1 เป๊ะ** (docs/21 §21.4 บันทึกไว้ว่า "ยอดถูก 36,306,490")
และ seats รายคอร์สตรงกับที่ query ตรง ๆ ตอน M1 ทั้ง 6 คอร์ส — ยืนยันว่า aggregation ไม่ได้นับเกินหรือขาด

## บั๊กที่เจอระหว่างทำ

**การคำนวณ delta เรียกตัวเองซ้ำไม่รู้จบ** — `runAnalytics` เรียกตัวเองเพื่อหาช่วงก่อนหน้า
แต่การเรียกซ้ำนั้นก็มี `groupBy` ติดไปด้วย จึงเรียกต่อไปเรื่อย ๆ จนเทส timeout 3 ตัว
แก้ด้วย `RunOptions.skipDelta` และ **เพิ่มเทสที่มี timeout 3 วินาทีไว้กันไม่ให้กลับมาอีก**

## สิ่งที่ยังทำไม่ได้

| เรื่อง | เหตุผล |
|---|---|
| ทดสอบชั้น LLM กับ Hermes จริง | ยังไม่มี endpoint — ทดสอบด้วย provider ปลอมครบทุกเส้นทางแล้ว (แปลงคำถามสำเร็จ · ถามกลับ · schema ไม่ผ่าน · LLM ล่ม · แต่งตัวเลข) |
| `channel_mix` แบบ `adOrOrganic` กับข้อมูลจริง | ยังไม่มีลูกค้าที่มาจาก Facebook Lead (ยังไม่มี token) — มี integration test ที่ปลูกข้อมูลแล้ว |
| ยอดขายจริง | ระบบ tag ยังไม่ส่งข้อมูลเข้ามา · legacy ยังเป็นของปลอม |

## ที่ต้องทำก่อนใช้กับข้อมูลจริง

1. สั่ง re-sync ลูกค้าให้ `leadAttribution` ขึ้นไปอยู่ใน `customers_scrubbed` (WF-D อัปเดตแล้ว)
2. ตั้ง `LLM_BASE_URL` / `LLM_MODEL` ชี้ Hermes แล้วลอง `--question`
3. import legacy ของจริง หรือรอข้อมูลจากระบบ tag
