# S11-M2 — ผลการทำงานจริง

วันที่รัน: 2026-08-28

ขอบเขต: scrub ข้อมูล synthetic จาก `line_crm_legacy` เข้า `line_crm_ai_test` บน MongoDB local เท่านั้น ไม่แตะ `line_crm_dev`, Atlas, LIFF, Google Sheets, n8n หรือ match engine/M3

## ข้อมูลตั้งต้น

```text
🎲 ปั้นข้อมูล synthetic จาก profile ของ Inner.xlsx (Inner2025, Inner2026)
   คน 1550 · การชำระ 2017 · ที่นั่ง/รายการคอร์ส 2239
```

## Integration tests

คำสั่ง:

```bash
RUN_MONGO_INTEGRATION=true npm test
```

ผลจริง:

```text
Test Files  22 passed (22)
Tests       184 passed (184)

Test Files  4 passed (4)
Tests       50 passed (50)
```

สรุป: core 184 ผ่าน + web 50 ผ่าน รวม 234 ผ่าน และ skipped = 0

## Typecheck

คำสั่ง:

```bash
npm run typecheck
```

ผลจริง:

```text
> @line-crm/core@0.1.0 typecheck
> tsc --noEmit

> @line-crm/web@0.1.0 typecheck
> tsc --noEmit

> typecheck:scripts
> tsc --noEmit -p tsconfig.scripts.json
```

## Scrub จริงและ idempotency

คำสั่งรอบแรก:

```bash
npm run legacy:scrub -- --legacy-uri mongodb://localhost:27018/?directConnection=true --ai-uri mongodb://localhost:27018/?directConnection=true --ai-db line_crm_ai_test --batch 500
```

ผลจริง:

```text
✅ legacy scrub เสร็จ: persons 1550 · payments 2017 · enrollments 2239
```

รันคำสั่งเดิมซ้ำ:

```text
✅ legacy scrub เสร็จ: persons 0 · payments 0 · enrollments 0
```

หมายความว่ารอบที่สองไม่พบ dirty document เพิ่ม และการเขียนปลายทางเป็น upsert ด้วย `_id` เดิม

## Verify

คำสั่ง:

```bash
npm run legacy:scrub -- --legacy-uri mongodb://localhost:27018/?directConnection=true --ai-uri mongodb://localhost:27018/?directConnection=true --legacy-db line_crm_legacy --ai-db line_crm_ai_test --verify
```

ผลจริง:

```text
legacy_persons         1550  → scrubbed 1550   dirty เหลือ 0
legacy_payments        2017  → scrubbed 2017   dirty เหลือ 0
legacy_enrollments     2239  → scrubbed 2239   dirty เหลือ 0
ตรวจ PII ในฉบับ scrub: ไม่พบเบอร์เต็ม / อีเมลเต็ม / raw / socialHandle  ✅
join ได้กับ customers_scrubbed: phoneHash ตรงกัน 0 คน · emailHash ตรงกัน 0 คน
```

`0 คน` ถูกต้อง เพราะข้อมูล legacy เป็น synthetic และไม่มีข้อมูลลูกค้า LINE ชุดเดียวกันให้ join

ทดสอบทางลบโดยชี้ `--ai-db` ไปยังฐานว่างแล้ว สคริปต์รายงานจำนวน scrubbed เป็น 0 และจบด้วย exit code 1 ตามที่ควรเป็น จึงไม่สามารถรายงานผ่านทั้งที่ mirror ไม่ครบได้

## AI indexes และจำนวนข้อมูล

ผลตรวจแบบอ่านอย่างเดียว:

```text
customers_scrubbed docs=0 indexes=_id_,ix_phoneHash,ix_emailHash
legacy_persons_scrubbed docs=1550 indexes=_id_,ix_phoneHash,ix_emailHash,ix_lastPaid
legacy_payments_scrubbed docs=2017 indexes=_id_,ix_person,ix_yearMonth
legacy_enrollments_scrubbed docs=2239 indexes=_id_,ix_courseSession,ix_person
```

## สิ่งที่ทำ

- แยก token/hash helper กลางใน `packages/core/src/ai/tokens.ts` และให้ `scrubCustomer` ใช้ร่วมกันเพื่อรักษา hash parity
- เพิ่ม deterministic scrub สำหรับ person, payment, enrollment และ `safeSessionLabel`
- เพิ่ม `aiSync` ใน legacy 3 collection พร้อม claim/ack, lease 5 นาที และเพดาน 5 attempts
- เพิ่ม AI mirror indexes และสคริปต์ `npm run legacy:scrub`
- เพิ่ม unit/integration tests โดยไม่ปิดหรือลบ test เดิม
- เพิ่ม `updatedAt` ให้ payment/enrollment และ backfill จาก `createdAt` ในโหมด `--all` เพื่อให้ ack ป้องกันข้อมูลที่ถูกแก้ระหว่าง sync ได้ครบทั้ง 3 collection
- เพิ่ม typecheck สำหรับ `scripts/scrub-legacy.ts` และ fixed hash baseline เพื่อจับการเปลี่ยนสูตร hash โดยไม่ตั้งใจ
- ทำให้ `--verify` ล้มเหลวด้วย exit code 1 เมื่อจำนวนต้นทาง/ปลายทางไม่เท่ากัน หรือยังมี dirty ค้าง
- ไม่ใช้ LLM, ไม่ทำ match engine และไม่สร้าง `customer_links`

## ความเสี่ยง/ข้อจำกัด

- ต้องใช้ `AI_HASH_PEPPER` เดิมต่อไป ห้าม rotate เพราะจะทำให้ join กับ `customers_scrubbed` ที่ sync แล้วไม่ตรงกัน
- `MONGODB_MIRROR_URI` ต้องเป็น credential ของ `mirror_user` ที่เขียนได้เฉพาะ `line_crm_ai`; สคริปต์ไม่ใช้ `MONGODB_URI` เป็น AI target
- `aiSync` ที่อยู่ในข้อมูล legacy เดิมก่อน M2 อาจยังไม่มี field นี้ ต้องใช้ `--all` ครั้งแรกเพื่อ mark dirty แล้ว sync
- ยังไม่เริ่ม S11-M3 ตามขอบเขตงาน

---

## ผลรีวิว (โดยผู้รีวิว ไม่ใช่ผู้ทำ) — 2026-08-28

รันซ้ำเองทั้งหมด ไม่ยึดตามรายงานข้างบน

- `RUN_MONGO_INTEGRATION=true npm test` → core 185 · web 50 · skipped 0
- `npm run typecheck` ผ่าน
- **hash parity ทดสอบด้วยข้อมูลจริง**: หยิบคนจากฐาน legacy มาสร้างลูกค้า LINE ที่เป็นคนเดียวกัน
  แต่พิมพ์เบอร์คนละรูปแบบ (`060-111-871`) และอีเมลตัวพิมพ์ใหญ่ → `phoneHash` และ `emailHash` ตรงกันทั้งคู่
- **ทดสอบว่า join ใช้ได้จริง**: ยัดลูกค้าที่ตรงกัน 1 คนลง `customers_scrubbed` →
  `--verify` รายงาน `phoneHash ตรงกัน 1 คน · emailHash ตรงกัน 1 คน`
- **ทดสอบทางลบ**: ยัด doc ที่มีเบอร์/อีเมล/ชื่อจริงเข้า AI DB → ตรวจจับได้ + exit 1 ·
  ลบ doc ฝั่ง AI ออก 5 ตัว → count ไม่ตรง + exit 1
- สแกน PII ด้วย query อิสระทั้ง 3 collection: ไม่พบ key ต้องห้าม ไม่พบอีเมลเต็ม ชื่อถูก tokenize ครบ
  (มี 2 doc ที่ regex เตือนว่าเป็นเบอร์ ตรวจแล้วเป็นลำดับเลขบังเอิญใน SHA-256 ไม่ใช่เบอร์จริง)

### แก้เพิ่มระหว่างรีวิว

| แก้ | เหตุผล |
|---|---|
| `--prune` ในสคริปต์ scrub | คิว `aiSync` รู้จักแค่ของใหม่/ของแก้ **ไม่รู้จักของถูกลบ** — พอ regen ฐาน legacy (ULID ชุดใหม่) ของเดิมค้างใน AI DB ทำให้ยอดเป็น 2 เท่า (1550 → 3100) เจอตอนรีวิวจริง |
| `--verify` พิมพ์สาเหตุที่ตก | เดิมรู้ได้แค่จาก exit code คนอ่าน terminal เลื่อนผ่านแล้วนึกว่าผ่าน |
| เบอร์ใน generator เป็น 10 หลัก | บั๊กจาก M1 — เดิมปั้น 9 หลักซึ่งเป็นความยาวเบอร์บ้าน + เพิ่มเทสบังคับ `^\+66[689]\d{8}$` |
| เพิ่ม `docs/23` ใน index README | เดิมใส่แต่ `docs/22` |

### ข้อสังเกตที่ไม่ได้แก้ (ไม่บล็อก)

- คอมเมนต์ใน `tokens.ts` / `scrubLegacy.ts` เป็นภาษาอังกฤษ ต่างจากทั้ง repo ที่เป็นไทย
- `aiSync` เขียนซ้ำ 3 รอบใน `legacy/models.ts` แทนที่จะแยกเป็น type เดียว
- `verify()` โหลด doc ทั้งหมดขึ้น memory — พอสำหรับหลักพัน ถ้าข้อมูลจริงโตเป็นหลักแสนต้องเปลี่ยนเป็น stream

**สรุป: ผ่านครบทุกเกณฑ์ใน `docs/22` §5**
