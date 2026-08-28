# S11-M6 — Facebook Lead Ads → LINE CRM

> สเปก + บันทึกการทำจริง · เอกสารนี้เขียนก่อนลงมือ แล้วเติมผลรันจริงท้ายไฟล์

---

## 1. เป้าหมาย

ตอบคำถาม **"ลูกค้ามาจาก content ไหน ยิงแอดหรือ organic"** ซึ่งตอนนี้ตอบไม่ได้
ฟอร์ม LIFF มี `heardFrom` แต่บอกได้แค่ระดับ "Facebook" ไม่รู้ว่าโพสต์ไหน แคมเปญไหน คอร์สอะไร

```
Meta Lead Form  ──webhook──►  /api/webhook/facebook
                                  │ เก็บแค่ leadgen_id (ไม่มี PII)
                                  ▼
                            inbound_events (provider: "facebook")
                                  │
                            worker ดึงรายละเอียดจาก Graph API
                                  ▼
                     customers + identities(provider: "lead_ads")
                                  │
                            attribution: form_id/ad_id → คอร์ส/แคมเปญ
```

### อยู่ในสโคป
1. `GET /api/webhook/facebook` — ตอบ challenge ตอนตั้ง webhook
2. `POST /api/webhook/facebook` — ตรวจ `X-Hub-Signature-256` แล้ว enqueue
3. ดึงรายละเอียด lead จาก Graph API (`/{leadgen_id}`)
4. แปลงคำตอบในฟอร์ม → ฟิลด์ลูกค้า + สร้าง customer/identity
5. ตาราง attribution: `form_id` / `ad_id` → `courseCode` · แคมเปญ · ad/organic
6. สคริปต์ `npm run leads:sync` + `npm run smoke:facebook`
7. tests

### ❌ ไม่อยู่ในสโคป
- ไม่ทำ n8n workflow ใหม่ (ใช้สคริปต์ก่อน แบบเดียวกับ D24)
- ไม่ทำ analytics/รายงาน (M4)
- ไม่ยิงข้อความกลับหาลูกค้า
- ไม่แตะ LIFF, WF-A/C/D/E, ระบบ tag
- ไม่ใช้ LLM

---

## 2. Design Decision

| # | ประเด็น | ตัดสินใจ |
|---|---|---|
| **D31** | webhook เก็บอะไร | **เก็บแค่ `leadgen_id` + id แคมเปญ** — Meta ไม่ส่งข้อมูลลูกค้ามากับ webhook อยู่แล้ว จึงไม่มี PII ตกอยู่ใน `inbound_events` เลย (สอดคล้องกับ D4) |
| **D32** | ไม่มี env ของ Facebook | route ตอบ **404** เหมือนไม่มีอยู่จริง ไม่ใช่ 503 — endpoint สาธารณะไม่ควรบอกใบ้ว่ามีอะไรรออยู่ · ระบบส่วนอื่นต้องไม่พัง |
| **D33** | consent | **ห้ามสมมติว่ายินยอม** ถ้าฟอร์มไม่มีคำถาม consent → `consent: null` + ติดธง `needsConsent` · ห้ามส่งการตลาดจนกว่าจะได้ consent จริง |
| **D34** | attribution ที่ยังไม่รู้จัก | เก็บ `formId`/`adId` ดิบไว้ + `attributionPending: true` **ห้ามเดาคอร์สจากชื่อแอด** · มีคนเติมตาราง mapping แล้วค่อยรันย้อนหลัง |
| **D35** | ข้อมูลดิบจาก Graph API | **ห้ามเก็บทั้งก้อน** — map เป็นฟิลด์ที่ใช้จริงแล้วทิ้ง ฟอร์ม Meta ใส่คำถามอะไรก็ได้ ถ้าเก็บดิบจะกลายเป็นถังขยะ PII ที่ไม่มีใครรู้ว่ามีอะไร |

---

## 3. กลไกฝั่ง Meta ที่ต้องทำให้ถูก

### 3.1 ยืนยัน webhook (GET)

Meta เรียก `GET /api/webhook/facebook?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`
ต้องตอบ **`hub.challenge` เป็น text ล้วน** (ไม่ใช่ JSON) เมื่อ `hub.verify_token` ตรงกับที่ตั้งไว้ ไม่ตรง → 403

### 3.2 ลายเซ็น (POST)

```
X-Hub-Signature-256: sha256=<HMAC-SHA256(rawBody, APP_SECRET)>
```

- เซ็นด้วย **App Secret** ไม่ใช่ page token
- ต้องคำนวณจาก **raw body ก่อน parse** เหมือนฝั่ง LINE
- เทียบด้วย `timingSafeEqual` เสมอ
- Meta **ไม่มี** timestamp ในลายเซ็น จึงกัน replay ไม่ได้ที่ชั้นนี้ → กันด้วย idempotency ของ `leadgen_id` แทน

### 3.3 รูปแบบ payload

```jsonc
{
  "object": "page",
  "entry": [{
    "id": "<page_id>", "time": 1787900000,
    "changes": [{
      "field": "leadgen",
      "value": {
        "leadgen_id": "1234567890",
        "page_id": "…", "form_id": "…",
        "adgroup_id": "…", "ad_id": "…",
        "created_time": 1787900000
      }
    }]
  }]
}
```

**ไม่มีชื่อ เบอร์ อีเมล** — ต้องไปดึงเองจาก Graph API ด้วย page access token
`GET /v21.0/{leadgen_id}?access_token=…` → `{ id, created_time, field_data: [{name, values:[…]}], ad_id, form_id }`

### 3.4 ต้องตอบ 200 เร็ว
Meta retry เมื่อไม่ได้ 200 ภายในไม่กี่วินาที และจะปิด subscription ถ้าพลาดต่อเนื่อง
จึงทำแบบเดียวกับ LINE: enqueue แล้วตอบ 200 · ดึงรายละเอียดทีหลัง

---

## 4. โครงข้อมูล

### 4.1 `inbound_events` (ใช้ของเดิม ไม่เพิ่ม collection)

| ฟิลด์ | ค่า |
|---|---|
| `eventId` | `leadgen_id` — **กันซ้ำในตัวเอง** ส่งซ้ำกี่ครั้งก็ไม่เกิดลูกค้าซ้ำ |
| `provider` | `"facebook"` |
| `channelId` | `page_id` |
| `raw` | `{ leadgenId, pageId, formId, adId, adgroupId, createdTime }` — **id ล้วน ไม่มี PII** |

### 4.2 `lead_form_mappings` (ใหม่)

```ts
export interface LeadFormMappingDoc {
  _id: string;              // lfm_<ULID>
  /** จับที่ระดับไหนก็ได้ อันที่เจาะจงกว่าชนะ: adId > formId > pageId */
  matchOn: "adId" | "formId" | "pageId";
  matchValue: string;
  courseCode: string | null;      // ต้องอยู่ใน courses.ts
  campaignName: string | null;
  adOrOrganic: "ad" | "organic" | "unknown";
  /** hashtag ที่ทีมการตลาดติดไว้กับ content เช่น ["#InnerMakeover"] */
  hashtags: string[];
  note: string | null;
  createdAt: Date; updatedAt: Date;
}
```

index: `ux_match {matchOn:1, matchValue:1}` unique

### 4.3 ที่เก็บ attribution ของลูกค้า

เพิ่มใน `CustomerDoc`

```ts
/** ที่มาจากโฆษณา/คอนเทนต์ — เติมเมื่อมาจาก Facebook Lead */
leadAttribution: {
  pageId: string | null;
  formId: string | null;
  adId: string | null;
  courseCode: string | null;
  campaignName: string | null;
  adOrOrganic: "ad" | "organic" | "unknown";
  /** true = ยังไม่มี mapping ต้องมีคนเติมแล้วรันย้อนหลัง */
  attributionPending: boolean;
  capturedAt: Date;
} | null;
```

---

## 5. การแปลงคำตอบในฟอร์ม

Meta ส่ง `field_data: [{ name: "full_name", values: ["สมชาย ใจดี"] }, …]`
ชื่อฟิลด์ตั้งเองได้ จึงต้องมีตารางแปลงที่ยืดหยุ่นแต่ **ไม่เดา**

| ฟิลด์มาตรฐานของ Meta | ไปที่ |
|---|---|
| `full_name` / `first_name`+`last_name` | `displayName` |
| `phone_number` | `phone` (ผ่าน `normalizePhone`) |
| `email` | `email` (ผ่าน `normalizeEmail`) |
| คำถาม consent (ต้องระบุชื่อฟิลด์ใน mapping) | `consent.dataProcessing` |
| อื่น ๆ | **ทิ้ง** (D35) — ถ้าจำเป็นต้องเก็บให้เพิ่มเป็นฟิลด์ที่ตั้งใจ ไม่ใช่กองรวม |

เบอร์จาก Meta มักมาเป็น `+66812345678` หรือ `0812345678` — `normalizePhone` รองรับทั้งคู่แล้ว
**แปลงไม่ได้ = ไม่เก็บ** ไม่ใช่เก็บค่าดิบ

---

## 6. กฎการสร้างลูกค้า

- ใช้ `resolveCustomer({ provider: "lead_ads", channelId: pageId, externalId: leadgenId })` — โครงเดิมรองรับอยู่แล้ว
- `source.channel = "facebook_lead"` · `sources` เพิ่ม `"facebook_lead"`
- **ห้าม merge อัตโนมัติด้วยเบอร์** (D3) — เบอร์ตรงกับลูกค้าเดิม → ตั้ง `pendingMerge` ให้คนตรวจ
- `customerStatus: "lead"` — คนกรอกฟอร์มโฆษณายังไม่ใช่ลูกค้าที่ซื้อ
- ตั้ง `sheetSync.dirty` และ `aiSync.dirty` เหมือนทางอื่น

---

## 7. Feature flag — "ใส่ token แล้วรันได้เลย"

env กลุ่ม `facebook` **optional ทุกตัว**

```
FACEBOOK_APP_SECRET=          # ตรวจลายเซ็น webhook
FACEBOOK_VERIFY_TOKEN=        # ตอบ challenge ตอนตั้ง webhook
FACEBOOK_PAGE_TOKEN=          # ดึงรายละเอียด lead จาก Graph API
FACEBOOK_PAGE_ID=             # กันรับ event ของเพจอื่น
FACEBOOK_GRAPH_VERSION=v21.0
```

| ขาดตัวไหน | ผลที่ต้องเป็น |
|---|---|
| ไม่มีอะไรเลย | route ตอบ 404 · `npm run leads:sync` บอกว่ายังไม่ตั้งค่าแล้วจบด้วย exit 0 · **ระบบส่วนอื่นทำงานปกติ** |
| มี `APP_SECRET` + `VERIFY_TOKEN` แต่ไม่มี `PAGE_TOKEN` | รับ webhook + enqueue ได้ · ดึงรายละเอียดไม่ได้ ค้างใน `inbound_events` รอ token (ข้อมูลไม่หาย) |
| ครบ | ทำงานเต็มระบบ |

---

## 8. Tests

**Unit**
- ⭐ ลายเซ็นถูก → ผ่าน · ผิด 1 ตัวอักษร → ไม่ผ่าน · ไม่มี header → ไม่ผ่าน
- GET challenge: verify_token ถูก → คืน challenge เป็น text · ผิด → 403
- ⭐ ไม่มี env → 404 ทั้ง GET และ POST
- payload หลาย entry/หลาย change → ได้หลาย event · `field` ที่ไม่ใช่ `leadgen` → ข้าม
- ⭐ `raw` ที่จะเก็บต้องไม่มี PII — assert ว่าไม่มี key ชื่อ/เบอร์/อีเมล
- แปลง `field_data`: full_name/first+last · เบอร์รูปแบบต่าง ๆ · อีเมลตัวพิมพ์ใหญ่ · ค่าที่แปลงไม่ได้ → null
- ⭐ ไม่มีคำถาม consent → `consent: null` + `needsConsent: true` **ห้ามเป็น true เอง** (D33)
- attribution: adId ชนะ formId ชนะ pageId · ไม่มี mapping → `attributionPending: true` และ `courseCode: null`
- courseCode ใน mapping ที่ไม่มีใน `courses.ts` → ปฏิเสธตอนบันทึก mapping

**Integration**
- ยิง webhook เดิมซ้ำ 5 ครั้ง → `inbound_events` มีแถวเดียว
- lead ที่เบอร์ตรงกับลูกค้าเดิม → `pendingMerge` ไม่ merge เอง
- เติม mapping ทีหลังแล้วรันย้อนหลัง → `attributionPending` เปลี่ยนเป็น false

**สคริปต์** `npm run smoke:facebook` — ยิง webhook ปลอมที่เซ็นลายเซ็นถูก แบบเดียวกับ `smoke:line`

---

## 9. เกณฑ์ผ่านงาน

- [ ] `RUN_MONGO_INTEGRATION=true npm test` ผ่าน skipped = 0
- [ ] `npm run typecheck` ผ่านทั้ง 3 ชุด
- [ ] ไม่มี env ของ Facebook → ระบบเดิมทำงานปกติทุกอย่าง และ route ตอบ 404
- [ ] `npm run smoke:facebook` ผ่าน (ลายเซ็นถูก → 200 · ผิด → 401)
- [ ] ยิงซ้ำไม่เกิดข้อมูลซ้ำ
- [ ] ไม่มี PII ใน `inbound_events` ของ provider `facebook`

## 10. ต้องมีอะไรก่อนใช้จริง (checklist ให้คนตั้งค่า)

1. Meta App + เพิ่ม product **Webhooks** และ **Facebook Login for Business**
2. สิทธิ์ `leads_retrieval`, `pages_show_list`, `pages_manage_metadata` (ต้องผ่าน App Review)
3. Page Access Token แบบ long-lived ของเพจที่ใช้ยิงแอด
4. ตั้ง Webhook URL = `https://<โดเมน>/api/webhook/facebook` · Verify Token ตามที่ตั้งใน env
5. Subscribe field **`leadgen`** ให้เพจนั้น
6. ใส่ env 5 ตัวใน Vercel แล้ว redeploy
7. เติม `lead_form_mappings` อย่างน้อย 1 แถวต่อแคมเปญที่ใช้อยู่


---

## 11. ผลรันจริง

วันที่: 2026-08-28

```text
RUN_MONGO_INTEGRATION=true npm test
core 253 passed (31 files) · web 64 passed (6 files) · skipped 0
   (ก่อนทำ M6: core 234 · web 54 → เพิ่ม 29 เทส)

npm run typecheck   ผ่านทั้ง core / web / scripts
```

**ยืนยัน D32 — ไม่ตั้ง env ของ Facebook แล้วระบบเดิมต้องไม่พัง**

```text
npm run check-env
✅ env ครบทุกกลุ่ม            ← ไม่บ่นถึง Facebook เลย

npm run leads:sync
⚠️  ยังไม่ได้ตั้ง FACEBOOK_APP_SECRET / FACEBOOK_VERIFY_TOKEN — webhook ยังรับ lead ไม่ได้
⚠️  ยังไม่ได้ตั้ง FACEBOOK_PAGE_TOKEN — ดึงรายละเอียด lead ไม่ได้
   event ที่รับมาแล้วยังค้างอยู่ในคิว ไม่หาย · ใส่ token แล้วรันใหม่ได้เลย
(จบด้วย exit 0 ไม่ throw)
```

**เทสที่ครอบเคสสำคัญ**

- ไม่มี env → route ตอบ 404 ทั้ง GET และ POST
- ลายเซ็นผิดไป 1 ตัวอักษร → 401 และ **ไม่แตะฐานข้อมูลเลย**
- ยิง webhook เดิมซ้ำ 5 ครั้ง → `inbound_events` เหลือแถวเดียว
- `raw` ที่เก็บลงคิวมีแค่ 6 คีย์ที่เป็น id ล้วน — assert ว่าไม่มีอักษรไทย ไม่มี `@` ไม่มีเบอร์
- event ของเพจอื่น → ถูกเมิน ไม่เข้าคิว
- ไม่มีคำถาม consent → `consent: null` + `needsConsent: true` (D33)
- มีคำถาม consent แต่ตอบปฏิเสธ → ยังถือว่าไม่ยินยอม
- ฟิลด์ที่ไม่รู้จัก (เช่น "รายได้ต่อเดือน") ถูกทิ้ง เหลือแค่ชื่อฟิลด์ให้คนตรวจ (D35)
- `adId` ชนะ `formId` ชนะ `pageId` · ไม่มี mapping → `attributionPending: true` ไม่เดาคอร์ส

## 12. สถานะ

| ส่วน | สถานะ |
|---|---|
| ตรวจลายเซ็น + webhook GET/POST | ✅ เสร็จ มีเทส |
| แกะ notification → คิว | ✅ เสร็จ มีเทส |
| แปลงคำตอบในฟอร์ม → ฟิลด์ลูกค้า | ✅ เสร็จ มีเทส |
| ตาราง attribution | ✅ เสร็จ มีเทส |
| ดึงรายละเอียดจาก Graph API | ✅ เขียนแล้ว **ยังไม่ได้ยิงของจริง** (ยังไม่มี token) |
| สร้างลูกค้าจาก lead | ✅ เขียนแล้ว ยังไม่มี integration test กับ Mongo |
| `npm run leads:sync` · `npm run smoke:facebook` | ✅ เสร็จ |

**ที่เหลือทำได้เมื่อมี token จริง**: ยิง `smoke:facebook` กับ production · รัน `leads:sync` กับ lead จริง 1 ใบ
แล้วเพิ่ม integration test ของ `upsertFromLead` (สร้างลูกค้า · เบอร์ซ้ำ → `pendingMerge` · เติม mapping แล้วรันย้อนหลัง)
