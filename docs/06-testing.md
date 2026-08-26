# Phase 6 — Testing Checklist

## 6.1 Unit Test (packages/core — ไม่ต้องมี network)

- [ ] `normalize.phone` — `0812345678`, `+66812345678`, `081-234-5678`, `66812345678` → `+66812345678` เหมือนกันหมด
- [ ] `normalize.phone` — input ขยะ (`abc`, `123`, ว่าง) → throw / null ไม่ใช่ hash มั่ว
- [ ] `normalize.email` — ` Somchai@GMAIL.com ` → `somchai@gmail.com`
- [ ] `pii.encrypt/decrypt` — round-trip ได้ค่าเดิม, ciphertext ต่างกันทุกครั้ง (IV สุ่ม)
- [ ] `pii.hash` — deterministic, pepper เปลี่ยน → hash เปลี่ยน
- [ ] `pii.mask` — `0812345678` → `08x-xxx-5678`, email → `so***@gmail.com`
- [ ] `lineSignature.verify` — signature ถูก = true, ผิด 1 byte = false, ความยาวต่างกัน = false ไม่ throw
- [ ] `internalHmac` — timestamp เก่ากว่า 300s = ปฏิเสธ (replay)
- [ ] `buildZod` — required / pattern / minItems / maxLength / visibleIf ทำงานตาม schema
- [ ] `buildZod` — field ที่ไม่อยู่ใน schema ถูกตัดทิ้ง (`.strict()`) ← mass assignment
- [ ] `merge` — winner ได้ `firstInteractionAt` ที่เก่ากว่า, `sources` รวมกัน, loser เป็น tombstone
- [ ] `toSheetRow` — คอลัมน์ตรงลำดับ, PII เป็น masked เสมอ, ไม่มี field ใหม่หลุดเข้ามา

## 6.2 LINE Follow

- [ ] user ใหม่ add OA → มี `customers` 1 record, `identities` 1 record, `interactions{type:"follow"}` 1 record
- [ ] `firstInteractionAt` == `createdAt` และ **ไม่เปลี่ยน**เมื่อมี event ถัดไป
- [ ] `source.channel == "line"`, `sources == ["line"]`
- [ ] `sheetSync.dirty == true`
- [ ] ได้ welcome message พร้อมปุ่มเปิด LIFF
- [ ] user ที่เคย follow → unfollow → follow ใหม่ → **ไม่เกิด customer ใหม่**, `customerStatus` กลับเป็น active

## 6.2b First Message (เก็บเฉพาะการทักครั้งแรก)

- [ ] user follow แล้วยังไม่ทัก → `firstMessageAt` ไม่มี, ไม่มี interaction `first_message`
- [ ] ทักครั้งแรก → `interactions{type:"first_message"}` 1 record + `firstMessageAt` ถูกตั้ง + `sheetSync.dirty = true`
- [ ] ทักครั้งที่ 2, 3, 4 → **ไม่มี interaction เพิ่ม**, `firstMessageAt` ไม่เปลี่ยน, `sheetSync.dirty` ไม่ถูกตั้ง ⭐
- [ ] ทักครั้งที่ 2 → `lastInteractionAt` อัปเดต (แต่ไม่ trigger Sheets sync)
- [ ] **ส่ง 5 ข้อความรัวพร้อมกัน (concurrent)** → `first_message` มี **1 record เท่านั้น** ⭐
- [ ] user ที่ทักก่อน follow (เจอได้จริง) → มีทั้ง `follow` และ `first_message`, `firstInteractionAt` = ตัวที่เกิดก่อน
- [ ] `db.interactions.find({type:"message"}).count() === 0` — ไม่มี type นี้อยู่จริงในระบบ
- [ ] **grep ข้อความที่ลูกค้าพิมพ์ ใน `interactions` และ `inbound_events.raw` → ต้องไม่เจอ** ⭐
- [ ] sticker / รูป / ไฟล์ → เก็บแค่ `messageType` ไม่มี id, ไม่มีชื่อไฟล์, ไม่มี URL
- [ ] n8n execution data ของ WF-A → ไม่มีข้อความลูกค้า

## 6.3 Duplicate / Retry Event

- [ ] ยิง webhook payload เดิม (`webhookEventId` เดิม) 3 ครั้ง → `inbound_events` มี 1 record, `interactions` มี 1 record
- [ ] LINE ส่ง `deliveryContext.isRedelivery: true` → ประมวลผลได้ปกติ ไม่ error
- [ ] ยิง 2 request พร้อมกัน (concurrent) ด้วย eventId เดียว → มีตัวเดียวชนะ อีกตัวได้ E11000 แล้วตอบ 200

## 6.4 Webhook Security

- [ ] ไม่มี `x-line-signature` → `401`
- [ ] signature ผิด → `401` และ **ไม่มี** record ถูกสร้าง
- [ ] body ถูกแก้หลังเซ็น → `401`
- [ ] `events: []` (LINE verify button) → `200`
- [ ] `/api/internal/*` ไม่มี HMAC → `401`
- [ ] `/api/internal/*` HMAC ถูกแต่ timestamp เก่า 10 นาที → `401`

## 6.5 LIFF Auth (สำคัญที่สุด)

- [ ] เปิด LIFF ครั้งแรก ยังไม่ login → redirect ไป LINE Login แล้วกลับมาได้
- [ ] `POST /liff/session` ด้วย idToken ถูกต้อง → ได้ cookie + profile
- [ ] idToken หมดอายุ → `401` พร้อม code ให้ frontend สั่ง `liff.login()` ใหม่
- [ ] **idToken ของ channel อื่น** → `401` (ตรวจ `aud`)
- [ ] **ยิง `/liff/customer/profile` โดยใส่ `customerId` ของคนอื่นใน body** → ระบบใช้ค่าจาก session เท่านั้น, ข้อมูลคนอื่นไม่ถูกแตะ ⭐
- [ ] ไม่มี cookie → `401`
- [ ] cookie ถูกแก้/ปลอม signature → `401`
- [ ] เรียกจาก origin อื่น (curl + Origin header แปลก) → CORS block

## 6.6 Existing Customer / New Customer

- [ ] ลูกค้าเก่า (import มาแล้ว มีเบอร์ แต่ไม่มี lineUserId) → เปิด LIFF ครั้งแรก → เห็น "ลูกค้าใหม่" (ยังไม่ match)
- [ ] กรอกเบอร์ที่ตรงกับลูกค้าเก่า → **merge** → `identities` ของ LINE ย้ายไปอยู่กับ customer เดิม
- [ ] หลัง merge: `customer_profiles`, `interactions` ทั้งหมดย้ายตาม, ไม่มีของค้างที่ loser
- [ ] loser มี `status: "merged"`, `mergedInto` ชี้ถูก
- [ ] เข้า LIFF อีกครั้งหลัง merge → `bootstrap` คืนข้อมูลของ winner
- [ ] merge 3 ชั้น (A→B→C) → resolve ตามไปถึง C ได้, ไม่ loop ค้าง

## 6.7 LIFF Form Submit

- [ ] submit ครบทุก required → `200`, `revision = 1`
- [ ] submit ขาด required → `400 VALIDATION_FAILED` พร้อมชื่อ field ที่ผิด
- [ ] submit ด้วย `formVersion` เก่าที่ถูก archive แล้ว → `409` + client reload schema
- [ ] **กด Submit รัว 3 ครั้ง (Idempotency-Key เดียวกัน)** → `customer_profiles` มี 1 record
- [ ] submit ครั้งที่ 2 (คนละ key) → `revision = 2`, ของเดิมยังอยู่ (append-only)
- [ ] ส่ง field แปลกปลอมมาใน body (`isAdmin: true`, `customerStatus: "vip"`) → ถูกตัดทิ้ง
- [ ] ส่ง `note` ยาว 10,000 ตัวอักษร → `400`
- [ ] submit เกิน rate limit (6 ครั้ง/นาที) → `429`
- [ ] เน็ตหลุดกลางทาง → กดใหม่ได้ ไม่ซ้ำ

## 6.8 MongoDB

- [ ] Insert: ทุก unique index มีจริงบน production (`db.getCollectionInfos()` ยืนยัน)
- [ ] Update: `$setOnInsert` ไม่ทับ `firstInteractionAt`
- [ ] transaction ของ merge — จำลอง error กลางคัน → ทุกอย่าง rollback ไม่มีสภาพครึ่ง ๆ
- [ ] connection reuse บน serverless — ยิง 50 request แล้ว connection count ไม่พุ่งชน limit ⭐
- [ ] ไม่มี field ที่เก็บ phone/email plaintext (`db.customers.findOne()` ตรวจด้วยตา)

## 6.9 Google Sheets Sync

- [ ] customer ใหม่ 1 คน → รอ 2 นาที → มี 1 แถวใหม่
- [ ] แก้ข้อมูลลูกค้าเดิม → แถวเดิมถูก update **ไม่เกิดแถวใหม่** ⭐
- [ ] 200 customer dirty พร้อมกัน → sync จบใน 1 รอบ, ไม่ชน quota
- [ ] รัน WF-C 2 instance พร้อมกัน → lock ทำงาน, ไม่มีแถวซ้ำ ⭐
- [ ] Sheets ตอบ error กลางคัน → `dirty` ยังเป็น true, รอบหน้าลองใหม่
- [ ] ack ไม่ถึง → รอบหน้าเขียนทับค่าเดิม ผลลัพธ์เหมือนเดิม
- [ ] คอลัมน์ staffNote ที่พนักงานพิมพ์เอง → **ไม่ถูกระบบเขียนทับ** ⭐
- [ ] ลบแถวใน Sheets แล้ว set dirty ใหม่ → แถวกลับมา (Sheets rebuild ได้จาก Mongo)
- [ ] เบอร์ใน Sheets เป็น masked ไม่ใช่เบอร์เต็ม

## 6.10 Failure & Recovery

- [ ] ปิด n8n → follow user ใหม่ → `inbound_events` เป็น `pending`, LINE ยังได้ 200
- [ ] เปิด n8n กลับมา → WF-D กวาดขึ้นมาทำภายใน 1–2 นาที → customer ถูกสร้าง ⭐
- [ ] Mongo ล่ม → `/api/webhook/line` ตอบ `503` → LINE retry เอง
- [ ] `/api/health` สะท้อนสถานะ Mongo จริง (ไม่ใช่ตอบ 200 ตลอด)
- [ ] event ที่ fail 5 ครั้ง → `dead` + มี alert เข้ากลุ่ม dev
- [ ] alert เดิมภายใน 15 นาที → ไม่ส่งซ้ำ
- [ ] LINE Profile API ตอบ 404 (user บล็อกบอท) → customer ยังถูกสร้าง แค่ไม่มี displayName

## 6.11 PII & Privacy

- [ ] log ของทั้งระบบ (Vercel + n8n execution) — grep หาเบอร์โทรจริง → **ต้องไม่เจอ** ⭐
- [ ] error message ที่ส่งกลับ client ไม่มี stack trace / ชื่อ collection / connection string
- [ ] `scrub` → ข้อความไม่มี PII เหลือ; `restore` → กลับเป็นเหมือนเดิม 100%
- [ ] `pii_tokens` มี TTL และหมดอายุจริง
- [ ] `restore` ด้วย jobId ของคนอื่น → `403`

## 6.12 Load / Smoke

- [ ] ยิง 100 follow event ใน 10 วินาที → ไม่มี event หาย, p95 < 500ms
- [ ] LIFF โหลดบน 3G (throttle) → first paint < 3s, มี loading state ตลอด
- [ ] LIFF บน iOS + Android LINE app จริง (ไม่ใช่แค่ browser) ⭐
- [ ] เปิด LIFF จาก external browser (นอก LINE app) → แสดงข้อความให้เปิดใน LINE

---

## 6.13 เครื่องมือทดสอบ

| ต้องการ | ใช้อะไร |
|---|---|
| ยิง LINE webhook ปลอมพร้อม signature ถูกต้อง | `scripts/smoke-test.ts` (คำนวณ HMAC จาก channel secret) |
| ทดสอบ LIFF โดยไม่ต้อง deploy | `liff-cli` + ngrok, หรือ LIFF endpoint ชี้ preview URL ของ Vercel |
| Mongo assertion | `mongodb-memory-server` สำหรับ integration test |
| n8n workflow test | Manual execution + pinned data |
