# Phase 0 — Requirement Analysis, Assumptions & Technical Risk

## 0.1 สรุป Requirement เป็นภาษาระบบ

| # | Requirement (จากโจทย์) | แปลเป็น Capability ทางเทคนิค |
|---|---|---|
| R1 | ตรวจจับ user ที่ add OA | รับ `follow` event → upsert customer จาก `lineUserId` |
| R2 | บันทึก first interaction | `firstInteractionAt` เขียนครั้งเดียวเท่านั้น (`$setOnInsert` / `$min`) |
| R3 | LIFF Form | LIFF v2 + ID Token verification ฝั่ง server |
| R4 | ส่งข้อมูลผ่าน Backend → n8n | Vercel API เป็น gateway เดียว, ไม่ให้ browser ยิง n8n ตรง |
| R5 | n8n validate + transform + save | n8n เป็น orchestrator, **ไม่ใช่** ที่เก็บ business rule |
| R6 | Sync Google Sheets | Sheets = read model ของพนักงาน, ไม่ใช่ source of truth |
| R7 | รองรับ Meta ในอนาคต | Identity model ต้องเป็น multi-provider ตั้งแต่วันแรก |

---

## 0.2 Requirement ที่ยังไม่ชัด (ต้องการคำตอบ)

| # | คำถาม | ทำไมสำคัญ | Assumption ที่ผมใช้ไปก่อน |
|---|---|---|---|
| Q1 | n8n โฮสต์ที่ไหน — n8n Cloud / self-host VPS / Docker บนเครื่อง? | ตัดสินใจเรื่อง network trust, static IP, webhook URL, การเก็บ credential | **สมมติ: self-host มี HTTPS domain คงที่** |
| Q2 | "ไฟล์ฐานข้อมูลลูกค้าเบื้องต้น" format อะไร (CSV/Excel/SQL dump) มีกี่แถว มี field อะไร | กำหนด migration script + identity matching | สมมติ CSV มี ชื่อ/เบอร์/อีเมล แต่ **ไม่มี** lineUserId |
| Q3 | **ลูกค้าเก่าที่ไม่มี lineUserId จะ match กับคนที่เข้า LIFF ได้ยังไง?** | นี่คือ chicken-and-egg ที่ใหญ่ที่สุดของโปรเจกต์ | ดู §0.4 RISK-1 |
| Q4 | Python scrubber/restore รับ input/return output เป็นอะไร (signature) | กำหนด API boundary ของ Privacy Layer | สมมติ `scrub(text) -> (scrubbed, token_map)` |
| Q5 | "Additional Questions" มีคำถามอะไรบ้าง กี่ข้อ | ออกแบบ form schema | ทำเป็น **schema-driven form** เพื่อไม่ต้องรู้ตอนนี้ |
| Q6 | ต้องมี PDPA consent checkbox + เก็บหลักฐานการยินยอมไหม | เก็บข้อมูลส่วนบุคคลในไทย = อยู่ใต้ PDPA | **ออกแบบให้มี** `consent` object (ถอดออกง่ายกว่าใส่ทีหลัง) |
| Q7 | จำนวนลูกค้าคาดการณ์ / traffic peak | ตัดสิน Mongo tier, rate limit, Sheets sync strategy | สมมติ < 50k customers, < 10 req/s |
| Q8 | พนักงานต้อง **แก้** ข้อมูลใน Sheets แล้วให้ sync กลับ Mongo ด้วยไหม | two-way sync ยากกว่า one-way มาก | **สมมติ one-way (Mongo → Sheets) เท่านั้น** |
| Q9 | LIFF ต้องรองรับการแก้ข้อมูลซ้ำ (กลับมากรอกใหม่) ไหม | versioning ของ profile submission | สมมติ **ได้** → เก็บเป็น revision |

---

## 0.3 Assumption ที่ผมตั้งไว้และเดินหน้าออกแบบไปแล้ว

1. LINE OA เป็น **Messaging API channel** และ LIFF app ผูกกับ **LINE Login channel** (คนละ channel — เป็นจุดที่พลาดกันบ่อย)
2. Vercel = Hobby/Pro plan → serverless function timeout 10–60s, **ไม่มี long-running process** → ห้ามพึ่ง background task ที่ไม่มี `waitUntil`
3. MongoDB Atlas (M0/M10) — รองรับ transaction (replica set) ได้
4. Google Sheets เข้าถึงผ่าน **Service Account** (ไม่ใช่ OAuth user)
5. ภาษา: TypeScript สำหรับ Vercel/LIFF, **Python เฉพาะ PII Layer** (ตามของเดิมที่มี)

---

## 0.4 Technical Risk (เรียงตามความรุนแรง)

### RISK-1 🔴 Identity Resolution: ลูกค้าเก่า ↔ LINE user
**ปัญหา:** ฐานลูกค้าเดิมไม่มี `lineUserId` แต่โจทย์ข้อ 2.3 บอกว่า "ดึงข้อมูลลูกค้าที่มีอยู่ในระบบมาแสดง" — ระบบจะรู้ได้ยังไงว่า LINE user คนนี้คือลูกค้าคนไหน

**ทางเลือก:**
| แนวทาง | ข้อดี | ข้อเสีย |
|---|---|---|
| A. ให้กรอกเบอร์โทรก่อน แล้ว match | แม่นยำ, ง่าย | ต้องกรอกเพิ่ม 1 step, เบอร์ผิด = match ผิด |
| B. ส่ง LIFF link แบบมี token เฉพาะคน (`?t=<signed>`) ผ่าน broadcast/1-1 | แม่นยำ 100%, UX ดีที่สุด | ต้อง map ลูกค้าเก่า→LINE ก่อน (ยังแก้ไม่ได้), token รั่วได้ |
| C. ไม่ match — ทุกคนที่มาจาก LINE = ลูกค้าใหม่ แล้ว merge ทีหลังด้วยเบอร์ | ง่ายสุด, POC เร็ว | มี duplicate ระหว่างทาง |

**ผมเลือก C + A ผสม:** สร้าง customer จาก `lineUserId` ทันที (ไม่บล็อก flow) แล้วเมื่อลูกค้ากรอกเบอร์ → ระบบทำ **deterministic match ด้วย `phoneHash`** → ถ้าเจอลูกค้าเก่า ให้ **merge** (ไม่ใช่เขียนทับ) โดย merge เป็น operation ที่ audit ได้และ reversible
**Trade-off:** มี duplicate ชั่วคราว แต่ไม่บล็อก UX และไม่ต้องรอ data cleaning ก่อน launch
**เตรียมไว้สำหรับ B:** ออกแบบ `/api/liff/session` ให้รับ optional signed invite token ตั้งแต่แรก

---

### RISK-2 🔴 LIFF `userId` ปลอมได้ ถ้าเชื่อค่าจาก frontend
**ปัญหา:** `liff.getProfile().userId` อยู่ฝั่ง browser — ใครก็ตามที่เปิด DevTools/ยิง API ตรง สามารถส่ง `userId` ของคนอื่นมาได้ → **อ่าน/เขียนข้อมูลลูกค้าคนอื่นได้ทั้งฐาน**

**ทางแก้ (บังคับ):** frontend ส่ง `liff.getIDToken()` (JWT) → backend verify ที่ `POST https://api.line.me/oauth2/v2.1/verify` ด้วย `client_id` = LINE Login Channel ID → เอา `sub` จาก response เป็น `lineUserId` เท่านั้น
**ห้าม** รับ `userId` จาก request body เด็ดขาด
**Trade-off:** เพิ่ม 1 network hop (~100–200ms) ต่อ request → แก้ด้วยการออก **session cookie (HttpOnly, SameSite=Lax, 30 นาที)** หลัง verify ครั้งแรก

---

### RISK-3 🟠 LINE Webhook Retry & Event Loss
**ปัญหา:** LINE ต้องได้ HTTP 200 ภายใน ~1 วินาที ถ้าช้า/พังจะ retry (และ retry มีเพดาน) — ถ้า chain คือ `LINE → Vercel → n8n → Mongo` แบบ synchronous ทั้งเส้น แล้ว n8n restart อยู่ = **event หายถาวร**

**ทางแก้: Inbound Outbox Pattern**
```
LINE → Vercel (verify signature) → insert inbound_events (Mongo, idempotent) → 200 OK ทันที
                                              ↓ (fire-and-forget + waitUntil)
                                          n8n webhook
                                              ↓
                              n8n cron ทุก 1 นาที กวาด status=pending ที่ค้าง (safety net)
```
**เหตุผล:** ack เร็ว + ไม่มี event หาย + retry ได้เอง แม้ n8n ล่ม
**Alternative:** ใช้ Upstash QStash / SQS เป็น queue จริง — ดีกว่าในระยะยาว แต่เพิ่ม vendor สำหรับ POC
**Trade-off:** Mongo ทำหน้าที่ queue = ไม่เหมาะถ้า > 100 events/s (ตอนนั้นค่อยย้ายไป QStash โดยไม่ต้องแก้ที่อื่น)

---

### RISK-4 🟠 Google Sheets เป็นคอขวดและสร้าง Duplicate Row
**ปัญหา:**
- Sheets API quota ~60 write/min/user → ถ้า sync ทุก event จะชนเพดานทันทีตอน broadcast
- n8n "Append or Update" ทำ read-then-write ที่ไม่ atomic → 2 workflow พร้อมกัน = **2 แถวซ้ำ**

**ทางแก้:** **ไม่ sync แบบ realtime** — ใช้ `dirty flag + batch reconcile`
- Mongo customer มี `sheetSync: { dirty: true, syncedAt, rowKey }`
- n8n Workflow C (cron ทุก 2 นาที) ดึงเฉพาะ `sheetSync.dirty = true` → `values.batchUpdate` ครั้งเดียว → เคลียร์ flag
- Column A = `customerId` เป็น row key (immutable), ใช้ในการหา row index
- ล็อกด้วย `sheetSync.lockedAt` กัน worker ซ้อน

**Trade-off:** พนักงานเห็นข้อมูลช้า 0–2 นาที (ยอมรับได้สำหรับ operational view) แลกกับความถูกต้องและไม่ชน quota

---

### RISK-5 🟠 Business Logic รั่วเข้าไปอยู่ใน n8n
**ปัญหา:** โจทย์ระบุชัดว่าไม่ต้องการ — แต่ n8n ล่อให้ทำมาก (Function node เขียน JS ได้)
**ทางแก้:** n8n **ห้ามต่อ MongoDB ตรง** สำหรับการเขียนข้อมูลลูกค้า — ให้เรียก internal API ของเราแทน:
```
n8n → POST /api/internal/customers/upsert  (HMAC signed)
```
n8n เหลือหน้าที่: trigger, routing, retry, fan-out, Sheets I/O, notification
**Trade-off:** เพิ่ม network hop และต้องดูแล API เอง แต่ได้ business rule ที่ **test ได้ด้วย unit test** และย้ายออกจาก n8n เมื่อไหร่ก็ได้

---

### RISK-6 🟡 PII เข้า AI Pipeline / เข้า Google Sheets
**ปัญหา:** Sheets แชร์ให้พนักงานหลายคน = เบอร์/อีเมลลูกค้ากระจาย; AI model = ข้อมูลออกนอกระบบ
**ทางแก้:**
- Mongo เก็บ `phoneEnc` (AES-256-GCM) + `phoneHash` (HMAC-SHA256 + pepper) สำหรับ match — **ไม่เก็บ plaintext ใน field ที่ index**
- Sheets ได้เฉพาะค่า mask `08x-xxx-1234` (ตั้ง config ได้ว่าจะ mask หรือไม่)
- AI Pipeline: บังคับผ่าน `POST /api/pii/scrub` (Python) ก่อนเสมอ — ไม่มีทางเรียก AI โดยไม่ผ่าน scrubber เพราะ AI client ถูก wrap ไว้ใน `packages/ai` ที่ require token_map
**Trade-off:** ค้นหาด้วยเบอร์แบบ partial (LIKE) ทำไม่ได้ — ต้องเป็น exact match เท่านั้น

---

### RISK-7 🟡 Vercel Serverless หยุดทำงานหลัง response
**ปัญหา:** โค้ดหลัง `res.json()` อาจไม่ทำงาน → การยิงต่อไป n8n หาย
**ทางแก้:** ใช้ `waitUntil()` จาก `@vercel/functions`; และมี cron reconciler เป็น safety net อยู่แล้ว (RISK-3)

---

### RISK-8 🟡 Duplicate Event จาก LINE
**ปัญหา:** LINE retry ส่ง event เดิมซ้ำ → `follow` ถูกนับ 2 ครั้ง
**ทางแก้:** `inbound_events` มี **unique index บน `eventId`** (LINE ส่ง `webhookEventId` มาให้) → insert ซ้ำ = duplicate key error = ตอบ 200 แล้วจบ (idempotent by construction)

---

## 0.5 Scaling Concern ที่ควรรู้ล่วงหน้า

| จุด | เพดาน | สัญญาณเตือน | ทางออกตอนนั้น |
|---|---|---|---|
| Mongo เป็น queue | ~100 events/s | `inbound_events` pending ค้าง > 1000 | ย้ายไป QStash/SQS (เปลี่ยนแค่ publisher) |
| Google Sheets | ~10k แถว เริ่มช้า, 60 write/min | sync รอบละ > 30s | ย้ายไป BigQuery/Metabase, Sheets เหลือแค่ view ล่าสุด |
| LINE ID Token verify | 1 hop ต่อ request | p95 latency > 500ms | cache session cookie (ทำตั้งแต่แรกแล้ว) |
| n8n single instance | SPOF | workflow error rate สูง | n8n queue mode (Redis) + worker หลายตัว |
| Vercel cold start | ~300ms | — | ยอมรับได้; ถ้าไม่ไหวย้าย webhook ไป edge runtime |
