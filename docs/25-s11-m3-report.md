# S11-M3 — ผลการทำงานจริง

วันที่รัน: 2026-08-28

ขอบเขต: match ข้อมูล scrubbed ภายใน `line_crm_ai_test` บน MongoDB local เท่านั้น ไม่แตะ `line_crm_dev`, Atlas, ฐาน legacy ต้นทาง หรือ analytics/M4

## สิ่งที่ทำ

- เพิ่ม `nameKeys` และ `nicknameKey` แบบ HMAC 12 ตัวใน customer/legacy scrub โดยใช้ helper กลาง
- เพิ่ม `customer_links` พร้อม unique pair index และ index สำหรับค้นตาม customer, legacy และสถานะ
- เพิ่มกฎ phone/email hash, การนับคู่แข่ง D29 และกฎชื่อที่ให้ได้เพียง `needs_review`
- เพิ่ม OpenAI-compatible LLM provider แบบ optional; ไม่มี env แล้ว deterministic path ยังเดินต่อ
- จำกัด candidate feature-only สูงสุด 5 คู่ต่อลูกค้า ตามกติกาที่เจ้าของโปรเจกต์ยืนยัน
- เพิ่ม `match:build` รองรับ `--no-llm`, `--dry-run`, `--verify`, `--plant` และ `--unplant`
- ป้องกัน `--plant`/`--unplant` ไม่ให้รันกับชื่อฐานที่ไม่มีคำว่า `test`
- เพิ่ม `nameKeys,nicknameKey` ใน field list ของ WF-D; ต้อง import workflow ใหม่ก่อนใช้กับข้อมูลจริง

## เตรียมข้อมูล local

```text
คน 1550 · การชำระ 2017 · ที่นั่ง/รายการคอร์ส 2239
legacy scrub เสร็จ: persons 1550 · payments 2017 · enrollments 2239
```

## Plant 25 และ deterministic match

```text
ปลูก fixture 25: phone 10 · family 3 · email 4 · name 4 · no-match 4

customers 25 · legacy persons 1,550
ชั้น 1 phoneHash : auto 10 · needs_review 3 (มีคู่แข่ง)
ชั้น 2 emailHash : auto 4 · needs_review 0
กฎ name feature  : needs_review 4
ชั้น 3 LLM       : ถาม 0 คู่ · same 0 · different 0 · unsure 0 · ข้าม 95
รวม link ใหม่ 21 · อัปเดต 0 · ถอด link เครื่องเก่า 0 · ไม่แตะของที่คนตัดสินแล้ว 0
เวลา 0.12 วิ
```

รันคำสั่งเดิมซ้ำ:

```text
รวม link ใหม่ 0 · อัปเดต 21 · ถอด link เครื่องเก่า 0 · ไม่แตะของที่คนตัดสินแล้ว 0
```

จำนวน document จึงไม่เพิ่ม และ unique index `ux_pair` ป้องกันคู่ซ้ำ

## Verify

```text
fixture customers 25 · links 21/21
คู่ซ้ำ 0 · auto ที่ไม่ปลอดภัย 0 · family auto 0
indexes ครบ
```

## Tests

คำสั่ง:

```bash
RUN_MONGO_INTEGRATION=true npm test
```

ผลจริง:

```text
Test Files  27 passed (27)
Tests       208 passed (208)

Test Files  4 passed (4)
Tests       50 passed (50)
```

รวม 258 tests ผ่าน และ skipped = 0

## Typecheck

```text
@line-crm/core  tsc --noEmit       ผ่าน
@line-crm/web   tsc --noEmit       ผ่าน
scripts         tsconfig.scripts   ผ่าน
```

## LLM และความเป็นส่วนตัว

- เครื่องนี้ยังไม่มี endpoint Hermes/Ollama ที่ตั้งค่าไว้ จึงไม่ได้ยิง LLM จริง
- ทดสอบด้วย provider/fetch ปลอม: JSON เสียมี retry, timeout ไม่ทำ batch ล้ม และผล `same` 0.99 ยังเป็น `needs_review`
- มี test ตรวจ payload ว่าไม่มี `customerId`, `legacyPersonId`, `<PERSON_...>`, อักษรไทย, `@` หรือเลขยาว 9 หลักขึ้นไป
- LLM เห็นเฉพาะคะแนน/boolean และ `pairId` ชั่วคราวภายใน batch

## แก้เพิ่มจากการรีวิวรอบสอง

- ถอด link ที่เครื่องสร้างเมื่อหลักฐานหายหรือ LLM ตอบ `different/unsure` จริง แต่ไม่ถอดเพราะ timeout/JSON เสีย
- รักษา `confirmed/rejected` ทุกกรณีและมีเงื่อนไขกันในคำสั่งลบอีกชั้น
- ตัด candidate เหลือ 5 คู่เฉพาะหลัง deterministic rules แล้ว จึงไม่ทำ name-rule pair หล่น
- `--verify` ผ่านได้บนฐานปกติที่ไม่มี fixture; ทดสอบจริง `fixture customers 0 · links 0/0`
- ตรวจ index ทั้ง key order, `unique` และ `sparse` ไม่ได้ดูแค่ชื่อ index

## ความเสี่ยงและงานที่ต้องทำก่อนใช้จริง

- ต้อง import `workflows/WF-D-ai-mirror.json` ใหม่และ re-sync customers เพื่อเติม `nameKeys`/`nicknameKey`; workflow import จะล้าง credential จึงต้องผูก Mongo credential ใหม่
- อย่าเปลี่ยน `AI_HASH_PEPPER` มิฉะนั้น name/hash join เดิมจะใช้ไม่ได้
- link จากชื่อหรือ LLM เป็น `needs_review` เสมอ และยังไม่มีหน้าจอให้พนักงานยืนยันตามขอบเขต M3
- งาน analytics/insights ยังไม่ได้เริ่ม เป็น S11-M4
