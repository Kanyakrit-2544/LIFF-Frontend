# S2 — LINE Webhook + Inbound Outbox

## 11.1 สิ่งที่ทำงานได้แล้ว

```
LINE  ──POST──▶  /api/webhook/line
                      │ 1. อ่าน raw body (ก่อน JSON.parse)
                      │ 2. verify x-line-signature (timing-safe)  ──ผิด──▶ 401
                      │ 3. redact ข้อความลูกค้าทิ้ง (D4)
                      │ 4. insertMany ordered:false → inbound_events
                      │    unique(eventId, provider) ตัด duplicate ที่ระดับ database
                      ▼
                  200 OK  (วัดจริง 6–20ms)
                      │
                      └─ after() ─▶ publish("LINE") ─▶ n8n
                                     dev: ข้าม (pull mode)
```

## 11.2 ทำไมออกแบบแบบนี้

| การตัดสินใจ | เหตุผล |
|---|---|
| อ่าน `req.text()` ก่อน parse | signature คำนวณจาก byte ดิบ — parse แล้ว stringify ใหม่ ลำดับ key/ช่องว่างอาจเปลี่ยน = signature ไม่ตรงทั้งที่ request ถูกต้อง |
| verify ก่อนแตะ database | request ปลอมต้องไม่ทำให้เกิด DB write เลย |
| `events: []` → 200 | LINE ยิงแบบนี้ตอนกดปุ่ม Verify ใน console — ตอบ 4xx จะตั้ง webhook ไม่ผ่าน |
| Mongo ล่ม → **502 ไม่ใช่ 200** | ให้ LINE retry เอง — ตอบ 200 ทั้งที่เขียนไม่สำเร็จ = ข้อมูลหายถาวร |
| `after()` แทน `await` ตอน push n8n | ตอบ LINE ก่อน แล้วค่อยแจ้ง n8n — push ล้มเหลวไม่กระทบ response |
| ไม่ log `userId` / body | docs/06 §6.11 — log ต้อง grep หา PII ไม่เจอ |

## 11.3 กลไก idempotency & retry

| กลไก | ที่อยู่ | ป้องกัน |
|---|---|---|
| `unique(eventId, provider)` | index | LINE retry ส่ง event เดิม → มี record เดียว |
| `ordered: false` | insertMany | ชุดที่มีทั้งซ้ำและใหม่ → ตัวใหม่ยังเข้าได้ครบ |
| two-phase claim | `claimPending()` | worker 2 ตัวไม่หยิบงานชิ้นเดียวกัน |
| lease 5 นาที | `releaseStaleClaims()` | worker ตายกลางคัน งานไม่ค้าง processing ตลอดกาล |
| exponential backoff | `failEvent()` | 30s → 60s → 120s … สูงสุด 30 นาที |
| dead letter ที่ 5 ครั้ง | `failEvent()` | ไม่วน retry ไม่รู้จบ |

## 11.4 ผลทดสอบจริง

**Unit + integration: 79 tests ผ่าน** (integration ยิง MongoDB จริง)

end-to-end กับ dev server:
```
health: ✅ db=4ms compressors=zstd,zlib

✅ ไม่มี signature → 401                             401    164ms
✅ signature ผิด (secret คนละตัว) → 401              401      9ms
✅ events ว่าง (ปุ่ม Verify ของ LINE) → 200          200      7ms
✅ follow event ใหม่ → accepted 1                    200     20ms
✅ ยิง event เดิมซ้ำ → duplicated 1, accepted 0      200     11ms
✅ ชุดผสม (ซ้ำ 1 + ใหม่ 2) → accepted 2              200     12ms
✅ message event → accepted 1                        200     13ms
✅ body ถูกแก้หลังเซ็น → 401                         401      6ms
```

**ยืนยัน D4 — ตรวจในฐานข้อมูลจริง:**
```
"สนใจคอร์ส" → ✅ ไม่พบ
"0812345678" → ✅ ไม่พบ
"สวัสดี"     → ✅ ไม่พบ

message event ที่เก็บจริง:
  message: { id: 'M-...', type: 'text' }     ← เหลือแค่ metadata
```

**log สะอาด** — ไม่มี userId, ไม่มี body, ไม่มีข้อความลูกค้า

## 11.4b ทดสอบกับ Atlas จริง (`line-crm-dev`, MongoDB 8.0.29)

```
health: ✅ db=38ms compressors=zstd,zlib

✅ ไม่มี signature → 401                             401    165ms
✅ signature ผิด → 401                               401      8ms
✅ events ว่าง → 200                                 200      6ms
✅ follow event ใหม่ → accepted 1                    200     55ms
✅ ยิง event เดิมซ้ำ → duplicated 1                  200     48ms
✅ ชุดผสม (ซ้ำ 1 + ใหม่ 2) → accepted 2              200     52ms
✅ message event → accepted 1                        200     52ms
✅ body ถูกแก้หลังเซ็น → 401                         401      9ms
```

**latency 48–55ms** (เทียบ 6–20ms กับ Mongo local) — ส่วนต่างคือ round-trip ไป Atlas
ยังห่างจากเพดานของ LINE (~1 วินาที) มาก

redaction บน Atlas ยืนยันแล้วเช่นกัน: `message: {"id":"M-...","type":"text"}` ไม่มีข้อความลูกค้า

> ⚠️ **Atlas shared tier ไม่รับ `storageEngine`** — storage compression เป็น snappy ไม่ใช่ zstd
> network compression zstd ยังทำงาน ดู [docs/10 §10.3](10-mongodb-compression.md)

## 11.5 วิธีรันทดสอบเอง

```bash
npm run db:test:up                          # MongoDB (replica set) port 27018
npm run create-indexes                      # สร้าง collection + index
npm test                                    # 79 tests
npm run dev --workspace @line-crm/web       # dev server
npm run smoke:line -- http://localhost:3000 # ยิง webhook ปลอมที่ signature ถูก
```

## 11.6 ยังไม่ได้ทำ (อยู่ใน S3–S4)

- แปลง event → customer (`identity/resolve`, `upsertFromLine`) — S3
- WF-A ใน n8n ที่มาดึงจากคิว — S4
- `/api/internal/events/pending` + `/ack` ให้ n8n เรียก — S4
