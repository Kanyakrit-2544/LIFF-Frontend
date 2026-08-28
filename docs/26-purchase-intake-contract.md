# S11-M3.5 — สัญญาการเชื่อมต่อ: ระบบติด Tag ลูกค้า → LINE CRM

> เอกสารนี้ใช้ 2 ทาง
> **§A** = ข้อกำหนดที่ระบบติด tag ต้องทำตาม — ส่งให้ทีม/AI ที่พัฒนาระบบนั้นอ่าน
> **§B** = สเปกฝั่งรับที่โปรเจกต์นี้ต้องสร้าง — ส่งให้ Codex ทำ
> ทั้งสองฝั่งพัฒนาแยกกันได้ทันที ไม่ต้องรอกัน เพราะสัญญาตรงกลางนิ่งแล้ว

---

## 1. ทำไมต้องมีเอกสารนี้

ตอนนี้ฟอร์ม LIFF เก็บแค่ **ตัวตนลูกค้า** (ชื่อ เบอร์ อีเมล เห็นเราจากช่องทางไหน) ไม่เก็บว่า
"ซื้อคอร์สอะไร รอบไหน จ่ายเท่าไร" ทำให้ตอบคำถามธุรกิจไม่ได้ เช่น

- สัปดาห์ที่ผ่านมาขายอะไรได้บ้าง อย่างละเท่าไร
- เดือนนี้ลูกค้าใหม่กี่คน ลูกค้าเก่ากี่คน
- ลูกค้ามาจาก content ไหน ยิงแอดหรือ organic

ระบบติด tag ที่กำลังพัฒนาอยู่จะเป็นคนรู้ข้อมูลส่วนที่ขาดนี้
เอกสารนี้กำหนดว่าจะส่งต่อกันด้วยรูปแบบอะไร เพื่อให้ **โยนเข้ามาแล้วทำงานได้ทันที** โดยไม่ต้องแก้ทั้งสองฝั่ง

### หน้าที่ของแต่ละฝั่ง — อย่าทำงานทับกัน

| ระบบ | รับผิดชอบ | ไม่ต้องทำ |
|---|---|---|
| ระบบติด tag | รู้ว่าใครซื้ออะไร จ่ายเท่าไร เมื่อไร ใครขาย | ไม่ต้อง dedupe ลูกค้า · ไม่ต้องรู้ว่าใครเป็นลูกค้าเก่า · ไม่ต้องคิดสถิติ |
| LINE CRM (โปรเจกต์นี้) | ระบุตัวลูกค้า · จับคู่กับประวัติเก่า · กันข้อมูลซ้ำ · scrub · คิดสถิติ | ไม่ยุ่งกับวิธีที่ฝ่ายขายติด tag |

**หลักการ**: ระบบ tag เป็นแหล่งความจริงของ "การซื้อ" · LINE CRM เป็นแหล่งความจริงของ "ตัวตนลูกค้า"

---

# §A ข้อกำหนดสำหรับระบบติด Tag

## A1. Endpoint

```
POST https://liff-frontend-three.vercel.app/api/partner/intake
Content-Type: application/json
```

### Header ที่ต้องส่งทุกครั้ง

| Header | ค่า |
|---|---|
| `x-partner-id` | รหัสระบบผู้ส่ง เช่น `tagger` (เราออกให้) |
| `x-timestamp` | Unix timestamp **หน่วยวินาที** ตอนส่ง |
| `x-signature` | `sha256=` + HMAC-SHA256 ของ `` `${rawBody}.${timestamp}` `` ด้วย secret ที่เราออกให้ |

ตัวอย่างการเซ็น (Node.js) — ต้องเซ็น **body ดิบทั้งก้อน ก่อน parse** ไม่ใช่ object ที่ stringify ใหม่

```js
const ts = Math.floor(Date.now() / 1000);
const raw = JSON.stringify(payload);
const sig = "sha256=" + crypto.createHmac("sha256", PARTNER_SECRET).update(`${raw}.${ts}`).digest("hex");
```

- หน้าต่างเวลา **300 วินาที** — นาฬิกาเครื่องคลาดเกินนี้จะถูกปฏิเสธ ต้องซิงก์เวลาเครื่อง
- secret แยกต่างหากต่อ partner ไม่ใช่ตัวเดียวกับ n8n — เพิกถอนได้โดยไม่กระทบระบบอื่น
- **ห้ามใส่ secret ใน URL, query string หรือ log**

## A2. รูปแบบข้อมูลที่ส่ง

```jsonc
{
  "events": [
    {
      // ── บังคับ ───────────────────────────────────────────────
      "eventId": "tagger-2026-08-28-000123",   // ไม่ซ้ำตลอดกาล ใช้กันข้อมูลซ้ำ (ดู A3)
      "type": "purchase",                       // purchase | purchase.void | intent | tag
      "occurredAt": "2026-08-28T10:15:00Z",     // ISO 8601 มี timezone เสมอ
      "revision": 1,                            // แก้ข้อมูลเดิม = eventId เดิม + revision เพิ่ม

      // ── ระบุว่าเป็นใคร: ส่งเท่าที่รู้ อย่างน้อย 1 อย่าง ──────────
      "subject": {
        "lineUserId": "Uxxxxxxxxxxxxxxxx",      // ⭐ ดีที่สุด ถ้ามีให้ส่งเสมอ
        "phone": "0812345678",                  // รูปแบบไหนก็ได้ เรา normalize เอง
        "email": "somchai@gmail.com",
        "fullName": "สมชาย ใจดี"                // ใช้ช่วยยืนยันเท่านั้น ไม่ใช้ระบุตัวคนเดี่ยว ๆ
      },

      // ── มีเมื่อ type = purchase ───────────────────────────────
      "payment": {
        "externalPaymentId": "IN-6908-00123",   // เลขสลิป/ใบเสร็จ — ถ้าไม่มีให้ใส่ id ของระบบคุณ
        "amount": 19710,                        // ⭐ ยอดของ "การชำระครั้งนี้" ทั้งก้อน ไม่ใช่ต่อคอร์ส
        "currency": "THB",
        "paidAt": "2026-08-28",
        "saleRep": "OO",                        // รหัส/ชื่อย่อพนักงานขาย
        "lines": [                              // คอร์สที่อยู่ในการชำระครั้งนี้ 1 ครั้งมีได้หลายคอร์ส
          {
            "courseLabel": "Inner",             // ชื่อที่ระบบคุณใช้ ส่งมาตามจริง
            "courseCode": "INNER",              // ถ้ารู้รหัสมาตรฐานให้ส่งด้วย (ดู A5)
            "sessionLabel": "27-28 Jun",
            "sessionStart": "2026-06-27",
            "kind": "enrolled"                  // enrolled | relearn | free | waitlist | transfer | refund | merchandise
          }
        ]
      },

      // ── มีเมื่อ type = intent (ดู A9) ─────────────────────────
      "intent": {
        "courseCode": "INNER",                  // null ได้ ถ้าสนใจแบบยังไม่เจาะจงคอร์ส
        "status": "hesitant",                   // interested | not_interested | hesitant | unknown
        "hesitationReason": "budget",           // มีเมื่อ status = hesitant
        "confidence": 0.93,                     // 0–1 จากโมเดล
        "source": "ai",                         // ai | staff
        "model": "hermes/gpt-4o-mini@2026-08"   // ระบุรุ่นที่ประเมิน ไว้ย้อนตรวจ
      },

      // ── ไม่บังคับ ป้ายอิสระสำหรับงานที่ยังไม่มีโครง ─────────────
      "tags": ["vip"],
      "attribution": {
        "source": "facebook",                   // facebook | instagram | tiktok | line | referral | walkin | other
        "adOrOrganic": "ad",                    // ad | organic | unknown
        "campaignId": "23851234567890",
        "contentRef": "#InnerMakeover"          // hashtag/โพสต์ที่ลูกค้ามาจาก
      }
    }
  ]
}
```

### ข้อจำกัดขนาด
- สูงสุด **100 event ต่อ 1 request** · body ไม่เกิน **1 MB**
- ส่งถี่ได้ไม่เกิน 60 request/นาที ต่อ partner

## A3. ⭐ กฎที่สำคัญที่สุด: `eventId` ต้องไม่ซ้ำและต้องคงที่

ทุก event ต้องมี `eventId` ที่ **ไม่ซ้ำกับ event อื่นตลอดกาล** และ **คงเดิมเมื่อส่งซ้ำ**

- ส่ง `eventId` เดิมซ้ำ → เราตอบ `duplicate` และ**ไม่ทำอะไรเลย** ปลอดภัย 100%
- ถ้าส่ง timeout / เน็ตหลุด / ไม่แน่ใจว่าถึงไหม → **ส่งใหม่ด้วย `eventId` เดิม** อย่าสร้างใหม่
- ถ้าสร้าง `eventId` ใหม่ทุกครั้งที่ retry → **ยอดขายจะถูกนับซ้ำ** และตัวเลขทั้งระบบผิด

แนะนำ: `${partnerId}-${วันที่}-${running number}` หรือ UUID ที่บันทึกคู่กับ record ในฝั่งคุณ

### การแก้ข้อมูลย้อนหลัง
- แก้ยอด/คอร์สของรายการเดิม → ส่ง `eventId` **เดิม** + `revision` เพิ่มขึ้น + ข้อมูลชุดใหม่ทั้งก้อน
- ยกเลิก/คืนเงิน → ส่ง event ใหม่ `type: "purchase.void"` พร้อม `"voids": "<eventId เดิม>"`
- **ห้ามลบข้อมูลด้วยการเงียบ** เราไม่มีทางรู้ว่าอะไรหายไป

## A4. ⭐ เงิน 1 ก้อน = 1 payment ห้ามแตกเป็นหลาย event

ถ้าลูกค้าจ่าย 33,900 บาทครั้งเดียวแล้วได้ 2 คอร์ส ต้องส่งเป็น

```jsonc
{ "payment": { "amount": 33900, "lines": [ {คอร์ส A}, {คอร์ส B} ] } }   // ✅ ถูก
```

**ห้าม**ส่งเป็น 2 event ที่มี amount 33,900 ทั้งคู่ (ยอดจะเบิ้ล) หรือหาร amount เอง (ราคาคอร์สไม่เท่ากัน หารแล้วผิด)

นี่ไม่ใช่ทฤษฎี — ข้อมูลขายจริงของ Inner Power มี 15% ของรายการที่ 1 การชำระครอบคลุมมากกว่า 1 คอร์ส
ถ้าทำผิดข้อนี้ ยอดขายรวมจะเกินจริงประมาณ **14.5%**

ถ้าคนหลายคนจ่ายรวมกันมาในสลิปเดียว: ส่งแยก event ต่อคน แต่ใส่ `externalPaymentId` เดียวกัน แล้วใส่ `amount` เฉพาะส่วนของคนนั้น (ถ้าแยกไม่ได้ ให้ใส่ยอดเต็มที่คนแรกคนเดียว แล้วคนอื่น `amount: null`)

## A5. ชื่อคอร์ส

ส่ง `courseLabel` ตามที่ระบบคุณใช้ได้เลย เราแปลงเป็นรหัสมาตรฐานให้ ถ้าแปลงไม่ได้เราจะ**เก็บไว้ในห้องพักรอ (quarantine) แล้วแจ้งกลับ ไม่ทิ้งเงียบ**

รหัสมาตรฐานปัจจุบัน (ถ้าระบบคุณอ้างอิงได้เลยยิ่งดี ส่งมาใน `courseCode`)

| courseCode | ชื่อคอร์ส | ชื่อที่เคยเจอในชีตขาย |
|---|---|---|
| `INNER` | Inner Makeover | Inner, Inner Makeover |
| `COMMU` | Communication | Commu, Communication, Mas Com |
| `PRESENT` | Presentation | Present, Presentation |
| `TTRT` | The Trainer | TTRT, TTRT'63, TTRT'64 |
| `DEEPIN` | Deep In | Deep In |
| `INNERCAMP` | Inner Camp | Inner Camp |
| `OTHER` | อื่น ๆ / สินค้า | อื่น ๆ, หนังสือ, ห้องพัก |

`kind` ต้องแยกให้ถูก เพราะมีผลกับ "ยอดคนเรียนที่ขายได้จริง"

| kind | ความหมาย | นับเป็นการขาย |
|---|---|---|
| `enrolled` | ลงเรียนปกติ | ✅ |
| `relearn` | ใช้สิทธิ์เรียนซ้ำ | ❌ |
| `free` | ได้ฟรี/แถม | ❌ |
| `waitlist` | รอคิว | ❌ |
| `transfer` | ย้ายคอร์ส | ❌ |
| `refund` | คืนเงิน | ❌ |
| `merchandise` | หนังสือ/ห้องพัก/ของขาย | ❌ |

## A9. ⭐ Intent — ผลวิเคราะห์ว่าลูกค้าสนใจหรือไม่

ระบบ tag อ่านแชตด้วย AI แล้วสรุปว่าลูกค้า **สนใจ / ไม่สนใจ / ลังเล** และ **ลังเลเพราะอะไร**
ส่งเข้ามาเป็น `type: "intent"` — **ส่งเฉพาะผลสรุป ห้ามส่งข้อความแชท** (ดู A6)

### ค่าที่รับได้ — รายการปิด ส่งค่าอื่นมาจะถูก quarantine

```text
status
├─ interested        สนใจ อยากได้ข้อมูล / กำลังตัดสินใจซื้อ
├─ not_interested    ปฏิเสธชัดเจน
├─ hesitant          สนใจแต่ยังไม่ตัดสินใจ
└─ unknown           อ่านแล้วสรุปไม่ได้

hesitationReason (ส่งเมื่อ status = hesitant)
├─ budget            งบยังไม่พร้อม / ราคาสูงเกิน
├─ not_needed        ยังไม่จำเป็นตอนนี้
├─ timing_conflict   รอบเรียนชนธุระ / ไม่ว่างวันนั้น
├─ not_ready         ยังไม่พร้อมด้านอื่น (ยังไม่มั่นใจ ยังไม่กล้า)
├─ needs_approval    ต้องปรึกษาคนอื่นก่อน (คู่สมรส/หัวหน้า)
└─ unknown           ลังเลแต่ไม่รู้เหตุผล
```

`timing_conflict` กับ `needs_approval` เพิ่มจากที่เสนอมา เพราะคอร์สมีรอบตายตัว
"ไม่ว่างรอบนี้" กับ "ไม่มีงบ" เป็นคนละปัญหาและแก้คนละวิธี (อันแรกเสนอรอบถัดไป อันหลังเสนอผ่อน)
ถ้ายุบรวมเป็น `not_ready` จะเสียข้อมูลที่เอาไปใช้ได้จริง

### กฎของ intent

**1. หนึ่ง event = หนึ่งคอร์ส** สนใจ 2 คอร์สในบทสนทนาเดียว → ส่ง 2 event (`eventId` คนละตัว)
ห้ามใส่ array ของคอร์สใน event เดียว เพราะแต่ละคอร์สมีสถานะและเหตุผลของตัวเอง

**2. `occurredAt` คือเวลาที่ลูกค้าพูด ไม่ใช่เวลาที่ AI ประมวลผล**
ถ้าประมวลผลย้อนหลังต้องใส่เวลาจริงของข้อความ ไม่งั้น timeline เพี้ยนทั้งระบบ

**3. ⭐ ความสนใจเปลี่ยนได้ — เราเก็บเป็นประวัติ ไม่ทับของเก่า**
ประเมินใหม่เมื่อไรให้ส่ง **`eventId` ใหม่** ทุกครั้ง
`revision` ใช้เฉพาะตอน **แก้ผลที่ส่งผิด** ไม่ใช่ตอนลูกค้าเปลี่ยนใจ

เหตุผล: ต้องตอบคำถามอย่าง *"คนที่เคยลังเลเพราะงบ สุดท้ายซื้อกี่คน"* ให้ได้
ถ้าทับของเก่า คำถามนี้จะตอบไม่ได้ตลอดกาล และนี่คือคำถามที่มีค่าที่สุดของการเก็บ intent

**4. `confidence` ต่ำกว่า 0.6 → เราเก็บไว้แต่ไม่นับในสถิติ** ส่งมาตามจริง อย่าปัดขึ้นให้ดูดี

**5. ห้ามส่ง `purchased` / `repeat_customer` เป็น intent หรือ tag**
ตรงกับที่ทีม tag เสนอ — CRM ตัดสินจาก `purchase` จริง ซึ่งเชื่อถือได้กว่าการอ่านแชท

**6. `source: "staff"` ชนะ `source: "ai"` เสมอ**
เจ้าหน้าที่แก้ผลที่ AI ประเมินผิด → ส่ง intent ใหม่ `source: "staff"` ระบบถือว่าจริงกว่า และ AI ทับไม่ได้อีก

**7. ต้องส่ง `model` ทุกครั้ง**
วันที่เปลี่ยนโมเดลแล้วตัวเลข "คนสนใจ" กระโดด เราต้องแยกออกว่าเพราะโมเดลเปลี่ยนหรือลูกค้าเปลี่ยนจริง

**8. ตัวเลขจาก intent เป็น "ค่าประเมิน" ไม่ใช่ข้อเท็จจริง**
ทุกรายงานที่ใช้ intent จะถูกกำกับว่ามาจากการประเมินของ AI พร้อมบอกรุ่นโมเดลและช่วง confidence
ต่างจากยอดขายที่เป็นข้อเท็จจริง — ห้ามเอาสองอย่างนี้ไปวางในตารางเดียวกันโดยไม่แยกป้าย

## A6. ❌ ห้ามส่งข้อมูลเหล่านี้

- **บทสนทนากับลูกค้า ข้อความแชท รูปภาพ ไฟล์แนบ** — เด็ดขาด (D4: ระบบนี้ไม่เก็บบทสนทนา redact ตั้งแต่ webhook)
- **ข้อความที่อ้างอิงจากแชทในทุกรูปแบบ** — ห้ามมี field `quote`, `evidence`, `snippet`, `summary` ที่มีคำพูดลูกค้า
  แม้แต่ใน `tags` ก็ห้ามใส่ข้อความอิสระที่ลอกมาจากสิ่งที่ลูกค้าพิมพ์
  อยากบอกว่าทำไม AI สรุปแบบนั้น → ส่ง `confidence` อย่างเดียวพอ
- เลขบัตรประชาชน เลขพาสปอร์ต เลขบัตรเครดิต ข้อมูลสุขภาพ
- ที่อยู่เต็ม (ถ้าจำเป็นต้องมีค่อยคุยกันเพิ่ม ตอนนี้ไม่ต้อง)
- `customerId` ของระบบ LINE CRM — เราเป็นคนกำหนดเอง ห้ามส่งมาบอกว่าเป็นใคร
- field แปลกปลอมนอก schema — เราจะไม่เก็บและอาจปฏิเสธทั้ง event

## A7. การตอบกลับและการ retry

เราตอบ **HTTP 200 พร้อมผลรายตัว** เสมอเมื่อ signature ถูกและ body อ่านได้ — event เสียบางตัวไม่ทำให้ทั้ง batch ล้ม

```jsonc
{
  "ok": true,
  "requestId": "job_01...",
  "summary": { "accepted": 8, "duplicate": 1, "quarantined": 1, "rejected": 0 },
  "results": [
    { "eventId": "tagger-…-000123", "status": "accepted" },
    { "eventId": "tagger-…-000124", "status": "duplicate" },
    { "eventId": "tagger-…-000125", "status": "quarantined", "reason": "unknown_course:Mas Com#7" },
    { "eventId": "tagger-…-000126", "status": "pending_identity", "reason": "เบอร์ตรงกับลูกค้ามากกว่า 1 คน รอเจ้าหน้าที่ตรวจ" }
  ]
}
```

| status | แปลว่า | คุณต้องทำอะไร |
|---|---|---|
| `accepted` | บันทึกแล้ว | ไม่ต้องทำอะไร |
| `duplicate` | เคยส่งมาแล้ว | ไม่ต้องทำอะไร — ถูกต้องแล้ว |
| `quarantined` | รับไว้แล้วแต่ยังใช้ไม่ได้ รอคนแก้ | ไม่ต้อง retry · ข้อมูลไม่หาย |
| `pending_identity` | รับไว้แล้ว แต่ยังไม่รู้แน่ว่าเป็นลูกค้าคนไหน | ไม่ต้อง retry |
| `rejected` | ข้อมูลผิด schema | **แก้แล้วส่งใหม่ด้วย eventId เดิม** |

รหัส HTTP อื่น

| รหัส | ความหมาย | ทำยังไง |
|---|---|---|
| 401 | signature/timestamp ไม่ถูก | ตรวจ secret และนาฬิกาเครื่อง **อย่า retry รัว ๆ** |
| 400 | body ไม่ใช่ JSON หรือเกินขนาด | แก้แล้วค่อยส่ง |
| 429 | ส่งถี่เกิน | รอแล้วค่อยส่งใหม่ |
| 5xx / timeout | ฝั่งเรามีปัญหา | **retry ด้วย eventId เดิม** แบบ exponential backoff (1s, 2s, 4s, … สูงสุด 5 ครั้ง) |

**ต้องมีคิวของตัวเอง** — ถ้าส่งไม่สำเร็จต้องเก็บไว้ส่งใหม่ ห้ามทิ้ง ระบบเราอาจ deploy อยู่ตอนที่คุณส่งพอดี

## A8. สิ่งที่ฝั่งเรารับประกันให้

- `eventId` เดิมส่งกี่ครั้งก็ไม่เกิดข้อมูลซ้ำ
- ไม่ทิ้งข้อมูลเงียบ — แปลงไม่ได้ก็เก็บใน quarantine พร้อมเหตุผล
- ไม่เดาว่าเป็นลูกค้าคนไหนเมื่อข้อมูลกำกวม (เบอร์ตรงกับหลายคน) → ตั้งธงรอคนตรวจ
- เราไม่ส่งชื่อ/เบอร์/อีเมลของลูกค้าออกไปให้ AI ภายนอก
- ตอบภายใน 10 วินาที

---

# §B สเปกฝั่งรับ (งานของโปรเจกต์นี้)

## B1. อยู่ในสโคป

1. `POST /api/partner/intake` + ตรวจ HMAC ด้วย secret แยกต่อ partner
2. `partner_events` — เก็บ event ดิบ + กันซ้ำด้วย unique index
3. `purchases` + `purchase_items` ใน `line_crm_dev` — โครงเดียวกับ `legacy_payments` / `legacy_enrollments` เพื่อให้ analytics รวมสองแหล่งได้ด้วย query เดียว
4. `customer_intents` — ผลประเมินความสนใจแบบ append-only (A9)
5. `partner_quarantine` — event ที่แปลงไม่ได้
6. ผูกเข้ากับลูกค้า: `lineUserId` → `identities` · ไม่มีก็ใช้ phone/email แบบมีเงื่อนไข (B4)
7. scrub เข้า `line_crm_ai` แบบเดียวกับ legacy (ใช้ `ai/tokens.ts` เดิม)
8. tests

## B2. ❌ ไม่อยู่ในสโคป
- ไม่ทำหน้าจอให้เจ้าหน้าที่จัดการ quarantine (แค่เก็บข้อมูลไว้ให้ครบ)
- ไม่ทำ analytics/insights (M4)
- ไม่แตะ LIFF form, WF-A/C/D, Google Sheets
- ไม่ import `Inner.xlsx` ของจริง

## B3. โครงข้อมูล

```ts
export interface PartnerEventDoc {
  _id: string;                 // pev_<ULID>
  partnerId: string;
  eventId: string;             // ของ partner
  revision: number;
  type: "purchase" | "purchase.void" | "intent" | "tag";
  occurredAt: Date;
  receivedAt: Date;
  status: "accepted" | "quarantined" | "pending_identity" | "voided";
  reason: string | null;
  customerId: string | null;
  purchaseId: string | null;
  /** payload ดิบหลัง validate — ห้ามมีข้อความสนทนา */
  raw: Record<string, unknown>;
  schemaVersion: number;
}

export interface PurchaseDoc {          // เงิน — โครงเดียวกับ LegacyPaymentDoc
  _id: string;                          // pur_<ULID>
  customerId: string | null;            // null = ยังระบุตัวไม่ได้
  partnerId: string;
  externalPaymentId: string | null;
  amount: number | null;
  currency: string;
  paidAt: Date | null;
  year: number;
  month: number | null;
  saleRep: string | null;
  attribution: { source: string | null; adOrOrganic: string | null; campaignId: string | null; contentRef: string | null } | null;
  status: "active" | "voided";
  sourceEventId: string;
  aiSync: { dirty: boolean; syncedAt: Date | null; lockedAt: Date | null; attempts: number; claimId?: string };
  createdAt: Date; updatedAt: Date; schemaVersion: number;
}

export interface CustomerIntentDoc {    // ผลประเมินความสนใจ — append-only ห้ามทับ
  _id: string;                          // int_<ULID>
  customerId: string | null;
  courseCode: string | null;            // null = สนใจแบบยังไม่เจาะจงคอร์ส
  status: "interested" | "not_interested" | "hesitant" | "unknown";
  hesitationReason: "budget" | "not_needed" | "timing_conflict" | "not_ready" | "needs_approval" | "unknown" | null;
  confidence: number;                   // 0–1
  /** ต่ำกว่าเกณฑ์ = เก็บไว้แต่ไม่นับในสถิติ */
  belowThreshold: boolean;
  source: "ai" | "staff";
  model: string | null;                 // null ได้เมื่อ source = staff
  /** เวลาที่ลูกค้าพูด ไม่ใช่เวลาที่ AI ประมวลผล */
  observedAt: Date;
  /** มีค่าเมื่อมี intent ใหม่ของ (customerId, courseCode) เดียวกันมาแทน */
  supersededAt: Date | null;
  partnerId: string;
  sourceEventId: string;
  aiSync: { dirty: boolean; syncedAt: Date | null; lockedAt: Date | null; attempts: number; claimId?: string };
  createdAt: Date; schemaVersion: number;
}

export interface PurchaseItemDoc {      // ที่นั่ง — โครงเดียวกับ LegacyEnrollmentDoc
  _id: string;                          // pit_<ULID>
  purchaseId: string;
  customerId: string | null;
  courseCode: string;
  courseLabel: string;
  kind: EnrollmentKind;                 // ใช้ type เดิมจาก legacy/courseCell.ts
  countsAsSeat: boolean;                // คำนวณจาก kind ห้ามให้ partner ส่งมาเอง
  sessionLabel: string | null;
  sessionStart: Date | null;
  sessionYear: number | null;
  createdAt: Date; schemaVersion: number;
}
```

**index**
- `partner_events`: `ux_partnerEvent {partnerId:1, eventId:1}` **unique** ← หัวใจของการกันซ้ำ
- `purchases`: `ix_customer {customerId:1}` · `ix_paidAt {paidAt:1}` · `ix_yearMonth {year:1,month:1}` · `ix_aiSyncQueue`
- `purchase_items`: `ix_purchase {purchaseId:1}` · `ix_courseSession {courseCode:1,sessionStart:1,countsAsSeat:1}`
- `customer_intents`: `ix_current {customerId:1, courseCode:1, supersededAt:1}` · `ix_observed {observedAt:1}` · `ix_funnel {status:1, hesitationReason:1, observedAt:1}` · `ix_aiSyncQueue`

## B4. ⭐ กฎการระบุตัวลูกค้า

| กรณี | ทำอะไร |
|---|---|
| มี `lineUserId` และเจอใน `identities` | ผูกกับ `customerId` นั้นเลย |
| มี `lineUserId` แต่ไม่เจอ | สร้างลูกค้าใหม่แบบ minimal + identity `line` (ทางเดียวกับ WF-A) |
| ไม่มี `lineUserId` · phone ตรงกับลูกค้า **1 คนเดียว** | ผูกได้ แต่ตั้ง `evidence: "phone_only"` |
| ไม่มี `lineUserId` · phone ตรงกับ **หลายคน** | **ห้ามเดา** → `status: "pending_identity"` · `customerId: null` |
| ไม่ตรงกับใครเลย | บันทึก purchase ไว้โดย `customerId: null` แล้วให้ M3 match ทีหลัง |

**ห้าม merge ลูกค้าอัตโนมัติจากข้อมูลที่ partner ส่งมา** (D3) — purchase ที่ยังไม่มีเจ้าของยังนับยอดขายได้ปกติ แค่ตอบไม่ได้ว่าใครซื้อ

## B5. กฎการคำนวณ

- `countsAsSeat` คำนวณจาก `kind` ที่ฝั่งเรา **ห้ามเชื่อค่าที่ partner ส่งมา**
- `amount` อยู่ที่ `purchases` เท่านั้น — `purchase_items` **ห้ามมี field เงิน** (บทเรียนจาก M1)
- `purchase.void` → ตั้ง `status: "voided"` ไม่ลบ record และไม่นับในสถิติ
- `revision` น้อยกว่าหรือเท่าที่มีอยู่ → ตอบ `duplicate` ไม่เขียนทับ

### กฎเฉพาะของ intent

- **append-only** — intent ใหม่ของ `(customerId, courseCode)` เดิม ไม่ลบของเก่า แค่ตั้ง `supersededAt` ให้ตัวก่อนหน้า
  "ตัวปัจจุบัน" = แถวที่ `supersededAt: null`
- `confidence < 0.6` → `belowThreshold: true` เก็บไว้แต่ analytics ต้องกรองออกโดยปริยาย
- intent ที่ `source: "ai"` **ห้ามทับ** intent ที่ `source: "staff"` ของคู่เดียวกันที่ยังไม่ถูก supersede
  (staff ทับ staff ได้ · staff ทับ ai ได้ · ai ทับ ai ได้ · ai ทับ staff **ไม่ได้** → ตอบ `rejected` พร้อมเหตุผล)
- **ข้อเท็จจริงจากการซื้อชนะค่าประเมินเสมอ** — ถ้ามี `purchase` ของคอร์สนั้น อย่านำ `not_interested`/`hesitant`
  ของคอร์สเดียวกันไปใช้ตอบว่า "ไม่สนใจ" ให้ถือว่า intent นั้นเป็นประวัติก่อนซื้อเท่านั้น
- `status`/`hesitationReason` ที่ไม่อยู่ในรายการปิด → **quarantine ทั้ง event** ห้ามแปลงเป็น `unknown` เงียบ ๆ
  (ถ้าแปลงเงียบ วันที่ทีม tag เพิ่มค่าใหม่แล้วลืมบอก เราจะไม่มีวันรู้)

## B6. Tests

**Unit**
- ⭐ ส่ง event เดิม 2 ครั้ง → ครั้งที่ 2 เป็น `duplicate` และไม่เกิด purchase ใหม่
- ⭐ payment 1 ก้อนมี 3 lines → เกิด 1 purchase + 3 items · ผลรวมเงินเท่ากับ amount ไม่ใช่ 3 เท่า
- `kind: relearn/free/waitlist/refund/merchandise` → `countsAsSeat: false`
- partner ส่ง `countsAsSeat: true` มาพร้อม `kind: "relearn"` → ระบบต้องไม่เชื่อ
- courseLabel ที่ไม่รู้จัก → `quarantined` ไม่ throw ไม่ทำให้ event อื่นในชุดเดียวกันล้ม
- signature ผิด/timestamp เก่าเกิน 300 วิ → 401
- body > 1MB หรือ events > 100 → 400
- `purchase.void` → purchase เดิมเป็น `voided` และไม่ถูกนับ
- `revision` ต่ำกว่าเดิม → ไม่เขียนทับ
- ⭐ intent ใหม่ของคู่เดิม → ตัวเก่าได้ `supersededAt` ไม่ถูกลบ และยัง query ประวัติได้
- ⭐ `source: "ai"` ทับ `source: "staff"` → `rejected` ไม่เขียนทับ
- `confidence: 0.4` → `belowThreshold: true`
- `status: "maybe"` (ค่านอกรายการ) → `quarantined` ไม่ใช่แปลงเป็น `unknown`
- event ที่มี field `quote` / `evidence` / `snippet` → `rejected` (กัน D4 หลุด)
- intent ที่มี `hesitationReason` แต่ `status != "hesitant"` → `rejected`

**Integration** (`RUN_MONGO_INTEGRATION=true`)
- ยิง 100 event พร้อมกัน 2 รอบ → purchase เท่าเดิม (unique index ทำงาน)
- phone ตรงกับลูกค้า 2 คน → `pending_identity` และ `customerId: null`
- มี `lineUserId` ที่ยังไม่มีในระบบ → สร้างลูกค้าใหม่ + identity ถูกต้อง

**สคริปต์ทดสอบ** `npm run smoke:partner` — ยิง event ปลอมที่เซ็น signature ถูก แบบเดียวกับ `smoke:line`

## B7. เกณฑ์ผ่านงาน
- [ ] `RUN_MONGO_INTEGRATION=true npm test` ผ่าน **skipped = 0**
- [ ] `npm run typecheck` ผ่านทั้ง 3 ชุด
- [ ] ยิง event เดิมซ้ำ 10 ครั้ง → purchase 1 รายการ
- [ ] ยอดรวมจาก `purchases` เท่ากับผลรวม `amount` ที่ส่งเข้ามา (ไม่เบิ้ล)
- [ ] event ที่ courseLabel ไม่รู้จัก อยู่ใน quarantine ครบ ไม่หายเงียบ
- [ ] ส่ง intent 3 รอบให้คนเดิมคอร์สเดิม → มี 3 แถว ตัวปัจจุบัน 1 แถว ประวัติครบ
- [ ] ไม่มี field ใดใน `customer_intents` ที่มีข้อความจากแชทลูกค้า
- [ ] เขียน `docs/27-s11-m35-report.md` พร้อมผลรันจริงจาก terminal

## B8. กฎที่ห้ามละเมิด
1. ห้ามเชื่อ `countsAsSeat` / `courseCode` จาก partner โดยไม่ตรวจ
2. ห้าม merge ลูกค้าอัตโนมัติจากเบอร์ที่ partner ส่งมา (D3)
3. ห้ามทิ้ง event เงียบ — แปลงไม่ได้ต้องเข้า quarantine พร้อมเหตุผล
4. ห้ามเก็บเงินไว้ที่ `purchase_items`
5. ห้าม log payload ที่มี PII — `logger.ts` redact อยู่แล้ว อย่าปิด
6. ห้ามใช้ `INTERNAL_HMAC_SECRET` ตัวเดียวกับ n8n
7. **ห้ามรับ field ที่มีข้อความจากแชท** (`quote`/`evidence`/`snippet`/`summary`) — ปฏิเสธทั้ง event (D4)
8. **ห้ามทับ intent เก่า** — append-only เท่านั้น ไม่งั้นตอบคำถาม funnel ไม่ได้ตลอดกาล
9. **ห้ามให้ค่าประเมินจาก AI ปนกับข้อเท็จจริงจากการซื้อโดยไม่แยกป้าย**
10. business logic อยู่ใน `packages/core`

---

## §C คำถามที่ยังต้องการคำตอบจากฝั่งระบบ tag

ตอบได้เมื่อไรค่อยปรับสัญญา — ระหว่างนี้ฝั่งเราสร้างตาม §B ได้เลย

1. **ระบบ tag รู้ `lineUserId` ไหม** ← สำคัญที่สุด ถ้ารู้ การจับคู่จะแม่น 100% ถ้าไม่รู้ ต้องพึ่งเบอร์ซึ่งมีเคสกำกวม
2. **รู้ยอดเงินไหม** ถ้าไม่รู้ จะตอบ "ขายได้เท่าไร" ไม่ได้ ตอบได้แค่ "กี่คน กี่ที่นั่ง"
3. tag เป็นข้อความอิสระหรือมีรายการตายตัว — ถ้าอิสระ ต้องมีตารางแปลง tag → คอร์ส
4. ใครติด tag (เซล/ระบบอัตโนมัติ) และติดตอนไหนเทียบกับเวลาจ่ายเงิน
5. แก้ย้อนหลัง/ยกเลิกได้ไหม และระบบรู้ตัวไหมว่าแก้อะไรไป
6. คาดว่าส่งกี่ event ต่อวัน (มีผลกับการตั้ง rate limit)
7. **AI ประเมิน intent ตอนไหน** — ทุกข้อความ / ทุกครั้งที่จบบทสนทนา / วันละครั้ง
   มีผลกับจำนวน event และกับการอ่านผล (ประเมินทุกข้อความจะเห็นความสนใจแกว่งไปมา)
8. **โมเดลที่ใช้ประเมิน intent เป็นตัวไหน และข้อความลูกค้าออกนอกองค์กรไหม**
   ถ้าใช้ ChatGPT ผ่าน Hermes = บทสนทนาลูกค้าออกไปที่ผู้ให้บริการภายนอก
   ฝั่งเราไม่ได้ห้าม (เป็นระบบคนละตัว) แต่ต้องรู้ไว้เพราะกระทบ PDPA และ consent ที่ลูกค้าเซ็น
9. **วัดความแม่นของ AI ยังไง** — มีชุดที่คนตรวจแล้วเทียบไหม ถ้าไม่มี ตัวเลข "คนสนใจ 50 คน" จะไม่มีใครรู้ว่าเชื่อได้แค่ไหน
