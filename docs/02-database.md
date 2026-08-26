# Phase 2 — MongoDB Design

## 2.1 Customer Identity Strategy (หัวใจของทั้งระบบ)

**ปัญหา:** ถ้าใช้ `lineUserId` เป็น primary key ตรง ๆ → พอมี Facebook เข้ามาจะต้องรื้อ schema ทั้งหมด

**ทางที่เลือก: Internal Customer ID + แยก `identities` เป็น collection ต่างหาก**
(รูปแบบเดียวกับ Segment / Stripe Customer)

```
identities (provider, externalId) ──unique──> customerId ──> customers
```

| ทางเลือก | ข้อดี | ข้อเสีย | ตัดสิน |
|---|---|---|---|
| `_id = lineUserId` | ง่ายสุด, ไม่ต้อง join | ผูกกับ LINE ตลอดไป, merge ไม่ได้, ลูกค้าคนเดียวมี 2 LINE = 2 record | ❌ |
| identity เป็น array ใน customers | ไม่ต้อง join | unique constraint ข้าม document ทำไม่ได้ดี, merge = ต้องย้าย array | ❌ |
| **collection `identities` แยก** | unique จริง, merge = update ทีเดียว, เพิ่ม provider ใหม่ = insert | ต้อง lookup 1 ครั้ง (index cover ได้ เร็วมาก) | ✅ |

**Internal ID:** `cus_` + ULID → เรียงตามเวลาได้, ไม่เดา, ปลอดภัยกว่า ObjectId เมื่อโผล่ใน URL/Sheets

---

## 2.2 Collections

### `customers` — Master Record
```jsonc
{
  "_id": "cus_01JQZX8K3M7YT2A9WD5N",
  "status": "active",              // active | merged | archived
  "mergedInto": null,              // ถ้า merged → cus_xxx ปลายทาง (tombstone ไม่ลบ)

  "displayName": "สมชาย ใจดี",     // ชื่อที่ระบบใช้แสดง
  "nickname": "ชาย",
  "fullNameEn": "Somchai Jaidee",
  "birthYear": 2535,               // หรือ "age" ถ้าคงตามไฟล์เดิม — รอยืนยัน (docs/08)
  "facebook": null,
  "instagram": null,
  "lineDisplayName": "Somchai",
  "pictureUrl": "https://profile.line-scdn.net/...",

  // ── PII (ดู §2.6) ─────────────────────
  "phoneHash": "a3f9...",          // HMAC-SHA256(E.164, PEPPER) — ใช้ match/dedupe
  "phoneEnc": "v1:iv:ct:tag",      // AES-256-GCM
  "phoneMasked": "08x-xxx-1234",   // ให้ Sheets / UI
  "emailHash": "7c21...",
  "emailEnc": "v1:iv:ct:tag",
  "emailMasked": "so***@gmail.com",

  "customerStatus": "lead",        // lead | prospect | customer | inactive
  "tags": ["line-follower", "form-completed"],

  "source": {                      // มาจากไหน "ครั้งแรก" (immutable)
    "channel": "line",             // line | facebook | ads | website | import | manual
    "campaign": null,
    "importBatchId": null
  },
  "sources": ["line", "import"],   // ทุก channel ที่เคยแตะ (สำหรับ attribution)

  "consent": {                     // PDPA
    "marketing": true,
    "dataProcessing": true,
    "version": "2026-08-01",
    "grantedAt": "2026-08-26T04:11:00Z",
    "ip": "1.2.3.4",
    "userAgent": "Line/14.2.0"
  },

  "profileRef": {                  // denormalize คำตอบล่าสุดไว้อ่านเร็ว
    "revision": 3,
    "formVersion": "v1",
    "updatedAt": "2026-08-26T04:11:00Z"
  },

  "sheetSync": {
    "dirty": true,
    "rowKey": "cus_01JQZX8K3M7YT2A9WD5N",
    "syncedAt": null,
    "lockedAt": null,
    "attempts": 0
  },

  "counters": { "milestones": 3, "formSubmits": 1 },   // นับเฉพาะ interactions ที่บันทึกจริง

  "firstInteractionAt": "2026-08-20T09:00:00Z",   // = ตอน follow — เขียนครั้งเดียว ($setOnInsert / $min)
  "firstMessageAt":     "2026-08-21T10:30:00Z",   // = ตอนทักครั้งแรก — ไม่มี field นี้ = ยังไม่เคยทัก
  "lastInteractionAt":  "2026-08-26T04:11:00Z",   // อัปเดตทุก event (ไม่ตั้ง dirty สำหรับข้อความ)
  "createdAt": "2026-08-20T09:00:00Z",
  "updatedAt": "2026-08-26T04:11:00Z",
  "schemaVersion": 1
}
```

**Index**
```js
db.customers.createIndex({ phoneHash: 1 }, { sparse: true, name: "ix_phoneHash" })
db.customers.createIndex({ emailHash: 1 }, { sparse: true, name: "ix_emailHash" })
db.customers.createIndex({ "sheetSync.dirty": 1, "sheetSync.lockedAt": 1 }, { name: "ix_sheetSyncQueue" })
db.customers.createIndex({ customerStatus: 1, createdAt: -1 })
db.customers.createIndex({ mergedInto: 1 }, { sparse: true })
db.customers.createIndex({ updatedAt: -1 })
db.customers.createIndex({ firstMessageAt: 1 }, { sparse: true })   // หา follower ที่ยังไม่เคยทัก
```
> ⚠️ **ไม่ทำ unique index บน `phoneHash`** โดยตั้งใจ — เพราะช่วง merge จะมี 2 record ถือเบอร์เดียวกันชั่วคราว ถ้า unique จะทำให้ write ล้มและ block flow ผู้ใช้ (ดู §2.5)

---

### `identities` — External ID → Customer
```jsonc
{
  "_id": "idn_01JQZX...",
  "customerId": "cus_01JQZX8K3M7YT2A9WD5N",
  "provider": "line",              // line | line_login | facebook | ig | lead_ads | email | phone | legacy_import
  "externalId": "U4af4980629...",  // lineUserId / psid / leadgen_id / legacy row id
  "channelId": "1234567890",       // LINE channel / FB page id — สำคัญเมื่อมีหลาย OA
  "verified": true,                // มาจาก cryptographic proof หรือแค่ผู้ใช้กรอก
  "meta": { "scope": ["profile"] },
  "linkedAt": "2026-08-20T09:00:00Z",
  "createdAt": "...", "updatedAt": "..."
}
```
```js
db.identities.createIndex({ provider: 1, channelId: 1, externalId: 1 }, { unique: true, name: "uq_identity" })
db.identities.createIndex({ customerId: 1 })
```
**นี่คือจุดที่ทำให้รองรับ Meta ได้โดยไม่ต้องแก้อะไร** — Facebook Lead มาก็แค่ `insert { provider: "lead_ads", externalId: leadgen_id }`

---

### `customer_profiles` — คำตอบจาก LIFF Form (append-only)
```jsonc
{
  "_id": "prf_01JQZX...",
  "customerId": "cus_...",
  "revision": 3,                   // เพิ่มทุกครั้งที่ submit
  "formId": "customer_onboarding",
  "formVersion": "v1",             // ผูกกับ schema ตอนนั้น → คำถามเปลี่ยนแล้วข้อมูลเก่ายังอ่านออก
  "answers": {                     // key = questionId (ไม่ใช่ข้อความคำถาม)
    "business_type": "retail",
    "monthly_budget": "50k_100k",
    "interested_services": ["seo", "ads"],
    "note": "อยากได้ใบเสนอราคาภายในสัปดาห์นี้"
  },
  "answersMeta": { "note": { "containsPii": true } },
  "submittedVia": "liff",
  "idempotencyKey": "liff_cus_..._1756180260",
  "clientMeta": { "liffVersion": "2.24.0", "os": "ios" },
  "createdAt": "..."
}
```
```js
db.customer_profiles.createIndex({ customerId: 1, revision: -1 })
db.customer_profiles.createIndex({ idempotencyKey: 1 }, { unique: true })
db.customer_profiles.createIndex({ formId: 1, formVersion: 1, createdAt: -1 })
```
**ทำไม append-only:** ได้ audit trail ฟรี, rollback ได้, วิเคราะห์ได้ว่าลูกค้าเปลี่ยนคำตอบยังไง

---

### `form_schemas` — ทำให้เพิ่ม/แก้คำถามได้โดยไม่ deploy
```jsonc
{
  "_id": "customer_onboarding@v1",
  "formId": "customer_onboarding",
  "version": "v1",
  "status": "published",           // draft | published | archived
  "title": { "th": "ข้อมูลเพิ่มเติม", "en": "Additional Information" },
  "sections": [
    {
      "id": "existing",
      "title": { "th": "ข้อมูลที่เรามีอยู่", "en": "Your Information" },
      "mode": "readonly_with_correction",
      "fields": [
        { "id": "displayName", "type": "text",  "label": {"th":"ชื่อ"},   "bindTo": "customers.displayName", "editable": true },
        { "id": "phone",       "type": "tel",   "label": {"th":"เบอร์โทร"}, "bindTo": "customers.phone",
          "validate": { "pattern": "^0[0-9]{8,9}$", "required": true }, "pii": true }
      ]
    },
    {
      "id": "additional",
      "fields": [
        { "id": "business_type", "type": "select", "label": {"th":"ประเภทธุรกิจ"},
          "options": [ {"value":"retail","label":{"th":"ค้าปลีก"}}, {"value":"service","label":{"th":"บริการ"}} ],
          "validate": { "required": true } },
        { "id": "monthly_budget", "type": "radio",  "options": [/*...*/] },
        { "id": "interested_services", "type": "checkbox", "validate": { "minItems": 1 } },
        { "id": "note", "type": "textarea", "validate": { "maxLength": 500 }, "pii": true,
          "visibleIf": { "field": "business_type", "op": "in", "value": ["retail"] } }
      ]
    }
  ],
  "createdAt": "...", "publishedAt": "..."
}
```
**Trade-off:** ยืดหยุ่นสูง แต่ validation ฝั่ง server ต้อง build zod schema จาก JSON แบบ dynamic → ผมเสนอ **`buildZodFromSchema()` ใน packages/core** พร้อม unit test เพื่อไม่ให้กลายเป็นรูโหว่

---

### `interactions` — Milestone Log (ไม่ใช่ chat log)

> **ตัดสินใจแล้ว:** เก็บเฉพาะ **เหตุการณ์สำคัญ** ไม่เก็บบทสนทนา
> `message` ธรรมดา (ครั้งที่ 2 เป็นต้นไป) **ไม่สร้าง record** และ **ไม่เก็บข้อความ**

```jsonc
{
  "_id": ObjectId(),
  "customerId": "cus_...",
  "type": "follow",       // follow | unfollow | first_message | form_submit
                          // | profile_update | merge | lead_ads_submit | staff_note
                          //   ⛔ ไม่มี "message" — ข้อความทั่วไปไม่ถูกบันทึก
  "channel": "line",
  "occurredAt": "2026-08-26T04:11:00Z",
  "sourceEventId": "01JQZ...",   // webhookEventId ของ LINE → idempotency
  "payload": { "messageType": "text" },   // ⚠️ ไม่มี text, ไม่มี textLength, ไม่มี sticker id
  "createdAt": "..."
}
```
```js
db.interactions.createIndex({ customerId: 1, occurredAt: -1 })
db.interactions.createIndex({ sourceEventId: 1 }, { unique: true, sparse: true })  // idempotency
db.interactions.createIndex({ type: 1, occurredAt: -1 })
db.interactions.createIndex({ occurredAt: 1 }, { expireAfterSeconds: 63072000 })   // TTL 2 ปี
```

#### วิธีจับ "ทักครั้งแรก" ให้ atomic + idempotent

`customers` มี `firstMessageAt` (ไม่มี field นี้ = ยังไม่เคยทัก)

```js
const r = await customers.updateOne(
  { _id: customerId, firstMessageAt: { $exists: false } },   // ← เงื่อนไขคือตัวล็อก
  { $set: { firstMessageAt: occurredAt, lastInteractionAt: occurredAt },
    $addToSet: { tags: "engaged" } }
)
if (r.modifiedCount === 1) {
  // นี่คือข้อความแรกจริง → บันทึก milestone + ให้ Sheets อัปเดต
  await interactions.insertOne({ type: "first_message", sourceEventId, ... })
  await customers.updateOne({_id: customerId}, {$set:{"sheetSync.dirty": true}})
} else {
  // เคยทักแล้ว → อัปเดตแค่เวลาล่าสุด ไม่สร้าง record ไม่ตั้ง dirty
  await customers.updateOne({_id: customerId}, {$max:{lastInteractionAt: occurredAt}})
}
```

**ทำไมใช้ conditional update แทน `if (!customer.firstMessageAt)`:** ถ้าลูกค้าส่ง 3 ข้อความรัว ๆ แล้ว n8n ประมวลผลพร้อมกัน การอ่านก่อนเขียนจะได้ `first_message` 3 record — conditional update ให้มีตัวเดียวชนะที่ระดับ database

**ทำไมข้อความธรรมดาไม่ตั้ง `sheetSync.dirty`:** ไม่งั้นลูกค้าแชท 20 ข้อความ = Sheets ถูกเขียนใหม่ 20 รอบ โดยที่ค่าในแถวแทบไม่เปลี่ยน — เปลืองโควตาเปล่า ๆ

#### ⚠️ `inbound_events.raw` ก็มีข้อความลูกค้าอยู่

ถ้าเก็บ payload ดิบทั้งก้อน = ยังเก็บบทสนทนาอยู่ดี (แค่ซ่อนอยู่อีกที่)
→ **redact ตั้งแต่ตอน insert** ใน `/api/webhook/line`:

```ts
function redactRaw(event) {
  if (event.type !== "message") return event
  const { text, ...rest } = event.message          // ทิ้ง text, stickerId, fileName ฯลฯ
  return { ...event, message: { id: rest.id, type: rest.type } }
}
```
ผลลัพธ์: **ไม่มีที่ไหนในระบบเก็บข้อความลูกค้าเลย** — ทั้ง Mongo, log, และ n8n execution data

---

### `inbound_events` — Outbox / Queue (แก้ RISK-3, RISK-8)
```jsonc
{
  "_id": ObjectId(),
  "eventId": "01JQZX8K...",   // LINE webhookEventId / FB entry id
  "provider": "line",
  "status": "pending",        // pending | processing | done | failed | dead
  "attempts": 0,
  "nextAttemptAt": "2026-08-26T04:11:30Z",
  "raw": { /* payload ดิบทั้งก้อน */ },
  "lastError": null,
  "receivedAt": "...", "processedAt": null
}
```
```js
db.inbound_events.createIndex({ eventId: 1, provider: 1 }, { unique: true })   // ← กัน duplicate
db.inbound_events.createIndex({ status: 1, nextAttemptAt: 1 })
db.inbound_events.createIndex({ receivedAt: 1 }, { expireAfterSeconds: 2592000 })  // TTL 30 วัน
```

---

### `integrations` — Config ของ Channel (ไม่ใช่ mapping ID)
```jsonc
{
  "_id": "line:2007xxxxxx",
  "provider": "line",
  "channelId": "2007xxxxxx",
  "displayName": "3S Suksonsin OA",
  "enabled": true,
  "config": { "liffId": "2007xxxxxx-abcdefgh", "loginChannelId": "2007yyyyyy" },
  "secretRef": { "accessToken": "env:LINE_CHANNEL_ACCESS_TOKEN" },  // ⚠️ เก็บแค่ "ชื่อ env" ไม่เก็บค่า
  "createdAt": "..."
}
```
**ทำไมแยกจาก `identities`:** โจทย์เขียนรวมกัน แต่สองอย่างนี้คนละ concern — `identities` = "คนนี้คือใครในแพลตฟอร์มนั้น" (per-customer), `integrations` = "เราต่อกับแพลตฟอร์มไหนบ้าง" (per-tenant)

---

### `pii_tokens` — Vault สำหรับ Scrubber/Restore
```jsonc
{
  "_id": "PHONE_a3f9c2",
  "jobId": "job_01JQ...",
  "type": "phone",             // name | phone | email | address | id_card
  "valueEnc": "v1:iv:ct:tag",
  "customerId": "cus_...",
  "createdAt": "...",
  "expiresAt": "2026-09-26T00:00:00Z"
}
```
```js
db.pii_tokens.createIndex({ jobId: 1 })
db.pii_tokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
```

---

### `audit_logs` — ใครทำอะไรกับข้อมูลลูกค้า
```jsonc
{ "actor": "n8n:wf-a", "action": "customer.merge", "customerId": "cus_...",
  "before": {}, "after": {}, "reason": "phone_match", "at": "..." }
```

---

## 2.3 ตารางสรุป Unique Key

| Collection | Unique Key | ป้องกันอะไร |
|---|---|---|
| `identities` | `(provider, channelId, externalId)` | LINE user เดียวกลายเป็น 2 ลูกค้า |
| `inbound_events` | `(eventId, provider)` | LINE retry → ประมวลผลซ้ำ |
| `interactions` | `sourceEventId` | นับ follow ซ้ำ |
| `customer_profiles` | `idempotencyKey` | กด Submit รัว ๆ → 3 revision |
| `customers` | — (ตั้งใจไม่ใส่) | ดู §2.5 |

---

## 2.4 Identity Resolution Algorithm

```
resolveCustomer(provider, channelId, externalId, hints?) :
  1. identity = identities.findOne({provider, channelId, externalId})
     → ถ้าเจอ: customerId = identity.customerId
                ถ้า customer.status == "merged" → ตามไป mergedInto (สูงสุด 5 hop)
                return { customerId, isNew: false }

  2. ไม่เจอ → deterministic match จาก hints:
     a. hints.phoneHash → customers.findOne({phoneHash, status:"active"})
     b. hints.emailHash → customers.findOne({emailHash, status:"active"})
     → ถ้าเจอ: link identity เข้า customer เดิม, return { customerId, isNew:false, linked:true }

  3. ไม่เจอทั้งหมด → สร้าง customer ใหม่ + identity ใหม่ (ใน transaction)
     return { customerId, isNew: true }
```

**เจตนา:** ตอน `follow` เรายังไม่มีเบอร์ → ได้ customer ใหม่ (ขั้นตอน 3); ตอนกรอกฟอร์มมีเบอร์ → เข้าขั้นตอน 2 → **merge**
**Confidence tier:** verified identity (LINE ID token) = high; เบอร์ที่ผู้ใช้พิมพ์เอง = medium → merge อัตโนมัติได้ แต่ log ไว้ให้ย้อนได้

---

## 2.5 Customer Merge

```js
merge(loser, winner):
  session.withTransaction(() => {
    identities.updateMany({customerId: loser}, {$set:{customerId: winner}})
    customer_profiles.updateMany({customerId: loser}, {$set:{customerId: winner}})
    interactions.updateMany({customerId: loser}, {$set:{customerId: winner}})
    customers.updateOne({_id: winner}, {
      $min: { firstInteractionAt: loserDoc.firstInteractionAt },
      $max: { lastInteractionAt:  loserDoc.lastInteractionAt },
      $addToSet: { sources: {$each: loserDoc.sources}, tags: {$each: loserDoc.tags} },
      $set: { "sheetSync.dirty": true },
      // field ว่างของ winner เติมจาก loser (fill-forward ไม่ทับของที่มีอยู่)
    })
    customers.updateOne({_id: loser}, {$set:{status:"merged", mergedInto: winner, "sheetSync.dirty": true}})
    audit_logs.insertOne({action:"customer.merge", ...})
  })
```
**กติกาเลือก winner:** (1) มี verified identity มากกว่า → (2) `createdAt` เก่ากว่า → (3) มีข้อมูลครบกว่า
**ทำไมไม่ลบ loser:** LINE/Sheets/Meta อาจยังถือ id เก่าอยู่ → tombstone ทำให้ resolve ตามไปเจอ winner ได้ และ **undo ได้**
**ต้องทำ:** Sheets row ของ loser ต้องถูก mark `MERGED → cus_winner` ไม่ใช่ปล่อยค้าง

---

## 2.6 PII Handling Pattern

| Field | เก็บยังไง | ใช้ทำอะไร |
|---|---|---|
| `phoneHash` | HMAC-SHA256(E.164, `PII_PEPPER`) | index, dedupe, match — **ย้อนกลับไม่ได้** |
| `phoneEnc` | AES-256-GCM(`PII_KEY`) | ให้พนักงานที่มีสิทธิ์ decrypt ดู |
| `phoneMasked` | `08x-xxx-1234` | Sheets, UI, log |

- normalize ก่อน hash เสมอ: `0812345678` → `+66812345678`; email → lowercase + trim
- key rotation: prefix `v1:` ในค่า ciphertext ตั้งแต่แรก → เปลี่ยน key ได้โดยไม่พัง
- **`PII_PEPPER` ห้ามเปลี่ยน** (เปลี่ยน = hash เดิมใช้ไม่ได้ทั้งฐาน) → เก็บแยกจาก `PII_KEY`

---

## 2.7 Schema Evolution
ทุก document มี `schemaVersion` → migration เป็น **lazy** (อ่านเจอเวอร์ชันเก่า → upgrade แล้วเขียนกลับ) ไม่ต้องหยุดระบบ
เพิ่ม field ใหม่: ต้อง optional เสมอ; เลิกใช้ field: mark deprecated 1 รอบ release ก่อนลบ
