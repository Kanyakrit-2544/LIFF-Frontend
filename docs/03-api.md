# Phase 3 — API Design

## 3.1 Convention ร่วม

- Base: `https://<project>.vercel.app/api`
- Content-Type: `application/json; charset=utf-8`
- ทุก response มี `requestId` (ULID) — ใช้ตามรอยข้าม Vercel → n8n → Mongo
- Error envelope มาตรฐาน:
```jsonc
{ "ok": false,
  "error": { "code": "VALIDATION_FAILED", "message": "phone รูปแบบไม่ถูกต้อง",
             "details": [{ "field": "phone", "rule": "pattern" }] },
  "requestId": "01JQZX..." }
```
- Error codes: `UNAUTHORIZED` `FORBIDDEN` `VALIDATION_FAILED` `NOT_FOUND` `CONFLICT` `RATE_LIMITED` `UPSTREAM_ERROR` `INTERNAL_ERROR`
- Idempotency: endpoint ที่เขียนข้อมูลรับ header `Idempotency-Key` — key ซ้ำ → คืน response เดิม (เก็บ 24 ชม.)

---

## 3.2 Endpoint Map

| Method | Path | Auth | หน้าที่ |
|---|---|---|---|
| POST | `/webhook/line` | LINE signature | รับ event → enqueue |
| GET/POST | `/webhook/meta` | Meta signature | (stub) verify + enqueue |
| POST | `/webhook/n8n` | HMAC | n8n callback → status update |
| POST | `/liff/session` | ID Token | verify + ออก session |
| GET | `/liff/bootstrap` | session cookie | profile + existing data + form schema (1 request) |
| POST | `/liff/customer/profile` | session cookie | รับคำตอบฟอร์ม |
| GET | `/internal/customers/:id` | HMAC | n8n อ่านข้อมูล |
| POST | `/internal/customers/upsert-from-line` | HMAC | n8n สั่ง upsert |
| POST | `/internal/customers/merge` | HMAC | สั่ง merge |
| GET | `/internal/sheets/pending` | HMAC | คิว dirty rows |
| POST | `/internal/sheets/ack` | HMAC | เคลียร์ dirty |
| POST | `/internal/events/pending` | HMAC | claim คิว event ค้าง + แปลงเป็น payload ให้ n8n |
| POST | `/internal/events/ack` | HMAC | ปิด event |
| POST | `/internal/events/dead` | HMAC | ดู dead letter metadata |
| POST | `/internal/logs/n8n-error` | HMAC | WF-E เขียน workflow error ลง audit log |
| POST | `/pii/scrub` | HMAC | Python — ลบ PII |
| POST | `/pii/restore` | HMAC | Python — เติม PII กลับ |
| GET | `/health` | — | liveness + Mongo ping |

> **`/api/customer` และ `/api/customer/update` ตามที่โจทย์ระบุ** — ผมแยกเป็น `/liff/customer/*` (public, session) กับ `/internal/customers/*` (HMAC) แทน เพราะ endpoint เดียวที่รับทั้งสอง trust level คือแหล่งกำเนิด privilege escalation ที่พบบ่อยที่สุด

---

## 3.3 `POST /api/webhook/line`

**Request** (จาก LINE)
```
x-line-signature: <base64 HMAC-SHA256 ของ raw body ด้วย channel secret>
```
```jsonc
{ "destination": "U206d...",
  "events": [{
    "type": "follow",
    "webhookEventId": "01JQZX8K3M...",
    "deliveryContext": { "isRedelivery": false },
    "timestamp": 1756180260000,
    "source": { "type": "user", "userId": "U4af4980629..." },
    "replyToken": "..."
  }]}
```

**Logic**
1. อ่าน **raw body** (ห้ามให้ framework parse ก่อน — signature คำนวณจาก byte ดิบ)
2. `crypto.timingSafeEqual` เทียบ signature → ผิด = `401` (ไม่บอกเหตุผล)
3. `events.length === 0` → `200` (LINE ใช้ verify endpoint ตอนตั้งค่า)
4. เก็บ `channelId = destination` ลง `inbound_events` ทุกตัว
5. `insertMany(inbound_events, { ordered: false })` → จับ E11000 = duplicate → ข้าม
6. `200 { ok: true }` **ทันที**
7. `waitUntil(fetch(N8N_WEBHOOK_LINE, { eventIds }))` — ล้มเหลวได้ ไม่กระทบ response

**Response**
```jsonc
{ "ok": true, "accepted": 1, "duplicated": 0, "requestId": "01JQZX..." }
```

**Security:** ห้าม log raw body ที่มีข้อความลูกค้า; log แค่ `eventId`, `type`, `userId` (hash)
**Scaling:** ถ้า events > 100/req (broadcast reply) → insertMany ยัง OK; ระวัง Vercel body limit 4.5MB

---

## 3.4 `POST /api/liff/session`

**Request**
```jsonc
{ "idToken": "eyJhbGci...", "inviteToken": "optional-signed-token" }
```

**Logic**
1. `POST https://api.line.me/oauth2/v2.1/verify` body `id_token` + `client_id=LINE_LOGIN_CHANNEL_ID`
2. ตรวจ `aud === LINE_LOGIN_CHANNEL_ID`, `iss === https://access.line.me`, `exp > now`
3. `lineUserId = payload.sub` ← **ค่านี้เท่านั้นที่เชื่อได้**
4. `resolveCustomer("line_login", channelId, sub)`
5. ออก session JWT (HS256, 30 นาที) → `Set-Cookie: sess=...; HttpOnly; Secure; SameSite=Lax; Path=/api`

**Response**
```jsonc
{ "ok": true,
  "customer": { "customerId": "cus_...", "displayName": "สมชาย ใจดี",
                "pictureUrl": "https://...", "phoneMasked": "08x-xxx-1234",
                "customerStatus": "lead", "isNew": false },
  "requestId": "01JQZX..." }
```

**⚠️ ห้ามคืน:** `phoneEnc`, `phoneHash`, `emailEnc`, `_id` ภายในอื่น ๆ — คืนเฉพาะ masked
**Rate limit:** 10 req/นาที/IP (ปกติเรียกครั้งเดียวต่อ session)

---

## 3.5 `GET /api/liff/bootstrap`

รวม 3 อย่างใน request เดียว (LIFF บนมือถือ 3G — ลด round-trip สำคัญมาก)

**Response**
```jsonc
{ "ok": true,
  "profile": { "customerId": "cus_...", "displayName": "สมชาย ใจดี", "pictureUrl": "..." },
  "existing": {                          // section "Existing Information"
    "displayName": "สมชาย ใจดี",
    "phone": "08x-xxx-1234",             // masked
    "email": "so***@gmail.com",
    "customerStatus": "lead",
    "memberSince": "2026-08-20"
  },
  "formSchema": { /* form_schemas document */ },
  "previousAnswers": { "business_type": "retail" },   // prefill จาก revision ล่าสุด
  "consentRequired": true,
  "requestId": "01JQZX..." }
```

---

## 3.6 `POST /api/liff/customer/profile`

**Request**
```
Cookie: sess=...
Idempotency-Key: liff_cus_01JQ..._1756180260
```
```jsonc
{ "formId": "customer_onboarding", "formVersion": "v1",
  "corrections": { "displayName": "สมชาย ใจดี", "phone": "0812345678", "email": "somchai@gmail.com" },
  "answers": { "business_type": "retail", "monthly_budget": "50k_100k",
               "interested_services": ["seo","ads"], "note": "อยากได้ใบเสนอราคา" },
  "consent": { "marketing": true, "dataProcessing": true, "version": "2026-08-01" } }
```

**Logic**
1. verify session → `customerId` (**ไม่รับ customerId จาก body**)
2. โหลด `form_schemas[formId@formVersion]` → `buildZodFromSchema()` → parse
   - ถ้า version นั้นไม่ `published` → `409 CONFLICT` + คืน schema ใหม่ให้ client reload
3. normalize `phone` → E.164, `email` → lowercase → คำนวณ hash
4. **identity check:** ถ้า `phoneHash` ตรงกับ customer อื่นที่ active → เรียก `mergeCustomers()`
5. transaction: insert `customer_profiles` (revision+1) → update `customers` → insert `interactions{type:"form_submit"}` → `sheetSync.dirty = true`
6. `waitUntil(notify n8n WF-B)`

**Response**
```jsonc
{ "ok": true, "customerId": "cus_...", "revision": 3, "merged": false,
  "message": "บันทึกข้อมูลเรียบร้อยแล้ว", "requestId": "01JQZX..." }
```

**Rate limit:** 5 submit/นาที/customer
**Security risk ที่ป้องกันไว้:** mass assignment — รับเฉพาะ field ที่อยู่ใน schema, ทิ้งที่เหลือทั้งหมด (`.strict()`)

---

## 3.7 `POST /api/internal/customers/upsert-from-line`

**Auth header**
```
x-signature: sha256=<HMAC(rawBody + "." + timestamp, INTERNAL_HMAC_SECRET)>
x-timestamp: 1756180260      # ต่างจาก now เกิน 300 วิ = ปฏิเสธ (กัน replay)
```

**Request**
```jsonc
{ "eventId": "01JQZX8K3M...", "provider": "line", "channelId": "2007xxxxxx",
  "lineUserId": "U4af4980629...", "eventType": "follow",
  "occurredAt": "2026-08-26T04:11:00Z",
  "profile": { "displayName": "Somchai", "pictureUrl": "https://..." } }
```
> n8n เป็นคน fetch LINE profile (`GET /v2/bot/profile/{userId}`) แล้วส่งมา — Vercel ไม่ต้องถือ channel access token ก็ได้

**Response**
```jsonc
{ "ok": true, "customerId": "cus_...", "isNew": true, "interactionCreated": true }
```
**Idempotent by:** `interactions.sourceEventId` unique → ยิงซ้ำ = `interactionCreated: false`, ไม่ error

---

## 3.8 `GET /api/internal/sheets/pending?limit=200`

**Logic:** `findAndModify` set `sheetSync.lockedAt = now` (lease 5 นาที) แล้วคืนรายการ — worker 2 ตัวจะไม่ได้ของชุดเดียวกัน

**Response**
```jsonc
{ "ok": true, "rows": [{
    "rowKey": "cus_01JQZX...", "customerId": "cus_01JQZX...",
    "values": ["cus_01JQZX...", "สมชาย ใจดี", "08x-xxx-1234", "so***@gmail.com",
               "lead", "line", "2026-08-20", "2026-08-26", "retail", "50k_100k", "seo,ads", ""]
  }],
  "columns": ["customerId","displayName","phone","email","status","source",
              "firstInteraction","lastUpdate","businessType","budget","services","staffNote"],
  "leaseUntil": "2026-08-26T04:16:00Z" }
```
**หมายเหตุ:** Vercel เป็นคน "แปลง customer → แถว Sheets" ไม่ใช่ n8n — เพราะการ mask PII เป็น business rule

## 3.9 `POST /api/internal/sheets/ack`
```jsonc
{ "results": [ { "customerId": "cus_...", "status": "ok", "rowIndex": 42 },
               { "customerId": "cus_...", "status": "error", "error": "quota" } ] }
```
`ok` → `dirty=false, syncedAt=now, attempts=0` | `error` → `attempts++`, ปลด lock; `attempts >= 5` → `dead` + แจ้งเตือน

---

## 3.9a `POST /api/internal/events/pending`

S4 เปลี่ยนจาก `GET` เป็น `POST` เพื่อให้ HMAC signing ใช้ raw body แบบเดียวกับ endpoint internal อื่น

**Request**
```jsonc
{ "limit": 50, "olderThanSec": 0, "provider": "line" }
```

**Response**
```jsonc
{ "ok": true, "claimed": 1,
  "skipped": { "noChannelId": 0, "notUserEvent": 0, "unsupportedType": 0 },
  "events": [{
    "eventId": "01JQZX...",
    "provider": "line",
    "channelId": "U206d...",
    "eventType": "follow",
    "lineUserId": "U4af...",
    "occurredAt": "2026-08-26T04:11:00.000Z",
    "messageType": null,
    "needsProfile": true,
    "attempts": 0
  }],
  "requestId": "job_01..." }
```

Endpoint นี้ปลด stale claims ก่อน แล้ว claim งานจาก `inbound_events` พร้อมแปลง raw LINE event ให้ n8n ใช้ได้ทันที:
- ไม่มี `channelId` → `failEvent()` และไม่ส่งให้น8น
- ไม่ใช่ user event → `ackEvents()` เป็น `done`
- type ไม่ใช่ `follow` / `unfollow` / `message` → `ackEvents()` เป็น `done`
- ไม่คืน raw payload และไม่คืนข้อความลูกค้า

---

## 3.9b `POST /api/internal/events/ack`

**Request**
```jsonc
{ "provider": "line",
  "results": [
    { "eventId": "01JQZX...", "status": "done", "customerId": "cus_01..." },
    { "eventId": "01JQZY...", "status": "failed", "error": "500: upsert failed" }
  ] }
```

`done` → ปิด event เป็น `done`  
`failed` → `failEvent()` เพิ่ม attempts/backoff และครบ 5 ครั้งเป็น `dead`

error จะถูก `redact()` ก่อนเขียนลง `lastError`

---

## 3.9c `POST /api/internal/events/dead`

**Request**
```jsonc
{ "limit": 50, "provider": "line" }
```

**Response**
```jsonc
{ "ok": true, "count": 1, "events": [
  { "eventId": "...", "provider": "line", "eventType": "follow",
    "attempts": 5, "lastError": "...", "receivedAt": "...", "processedAt": "..." }
] }
```

ไม่คืน `raw` เพราะมีข้อมูล identity ภายใน

---

## 3.9d `POST /api/internal/logs/n8n-error`

WF-E ใช้ endpoint นี้เพื่อบันทึก error ลง `audit_logs` แทนการส่ง alert ภายนอกใน S4

**Request**
```jsonc
{ "executionId": "123", "workflow": "WF-A", "node": "Upsert Customer", "message": "..." }
```

server จะ `redact()` อีกชั้นก่อนบันทึกเสมอ

---

## 3.10 `POST /api/pii/scrub` (Python runtime)
```jsonc
// request
{ "jobId": "job_01JQ...", "customerId": "cus_...",
  "payload": { "note": "โทรหาสมชาย 0812345678 นะ" },
  "fields": ["note"], "types": ["name","phone","email","address","id_card"], "ttlDays": 30 }

// response
{ "ok": true, "jobId": "job_01JQ...",
  "scrubbed": { "note": "โทรหา [NAME_1] [PHONE_1] นะ" },
  "tokenCount": 2, "receipt": "rcp_01JQ..." }   // ← ต้องมี receipt ถึงจะเรียก AI ได้
```

## 3.11 `POST /api/pii/restore`
```jsonc
{ "jobId": "job_01JQ...", "payload": { "summary": "[NAME_1] สนใจบริการ ติดต่อ [PHONE_1]" } }
→ { "ok": true, "restored": { "summary": "สมชาย ใจดี สนใจบริการ ติดต่อ 0812345678" } }
```
**Security:** restore ต้องตรวจว่า caller มีสิทธิ์เห็น PII ของ `customerId` นั้น — ไม่งั้นกลายเป็น PII oracle

---

## 3.12 Environment Variables

```bash
# LINE — Messaging API channel
LINE_CHANNEL_SECRET=
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_ID=

# LINE — Login channel (คนละอันกับข้างบน!)
LINE_LOGIN_CHANNEL_ID=
NEXT_PUBLIC_LIFF_ID=            # อันเดียวที่ public ได้

# Database
MONGODB_URI=
MONGODB_DB=line_crm

# Security
SESSION_JWT_SECRET=             # openssl rand -base64 48
INTERNAL_HMAC_SECRET=
PII_KEY=                        # 32 bytes base64 — AES-256-GCM
PII_PEPPER=                     # ห้ามเปลี่ยนหลัง production
ALLOWED_LIFF_ORIGINS=https://<project>.vercel.app

# n8n
N8N_PUSH_ENABLED=false
N8N_WEBHOOK_LINE=
N8N_WEBHOOK_FORM=
N8N_CALLBACK_SECRET=
API_BASE=http://host.docker.internal:3000
N8N_ENCRYPTION_KEY=

# Google (n8n ถือ ไม่ใช่ Vercel)
GOOGLE_SHEET_ID=
GOOGLE_SERVICE_ACCOUNT_JSON=

# Meta (Phase 2)
META_APP_SECRET=
META_VERIFY_TOKEN=
META_PAGE_ACCESS_TOKEN=
```
**กฎ:** ห้าม prefix `NEXT_PUBLIC_`/`VITE_` กับอะไรที่ไม่ใช่ LIFF ID — ค่าพวกนี้ถูก bundle ลง JS ที่ทุกคนอ่านได้
**ตรวจตอน boot:** `packages/core/env.ts` ใช้ zod validate ทุกตัว → ขาดตัวไหน = crash ทันทีตอน deploy ไม่ใช่ตอนมีลูกค้าใช้

---

## 3.13 Rate Limiting & Observability

| Endpoint | Limit | Key |
|---|---|---|
| `/webhook/line` | ไม่จำกัด (signature กันอยู่แล้ว) | — |
| `/liff/session` | 10/min | IP |
| `/liff/bootstrap` | 30/min | customerId |
| `/liff/customer/profile` | 5/min | customerId |
| `/internal/*` | 300/min | HMAC key id |

**Structured log ทุกบรรทัด:** `{ requestId, route, customerIdHash, latencyMs, status, errorCode }`
**ห้าม log:** phone/email plaintext, id_token, ข้อความลูกค้าเต็ม ๆ, secret ใด ๆ
