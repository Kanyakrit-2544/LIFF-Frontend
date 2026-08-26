# S3 — Customer Identity (รีวิว + สิ่งที่แก้)

โค้ด S3 เขียนโดย Codex — เอกสารนี้บันทึกผลรีวิวและบั๊กที่แก้

## 12.1 สิ่งที่ได้มา

| ไฟล์ | หน้าที่ |
|---|---|
| `identity/resolve.ts` | หาว่า LINE user นี้คือลูกค้าคนไหน — ไม่เจอก็สร้างใหม่ในทรานแซกชัน |
| `customers/upsertFromLine.ts` | แปลง event เป็นข้อมูลลูกค้า + บันทึก milestone |
| `api/internal/customers/upsert-from-line` | endpoint ที่ n8n เรียก (HMAC + replay window) |

**สิ่งที่ทำได้ถูกต้องตั้งแต่แรก:** ทรานแซกชันตอนสร้างลูกค้าใหม่ (follow พร้อมกัน 8 ครั้ง → ลูกค้า 1 คน), การตามสาย merge, `firstInteractionAt` แบบ `$gt` ที่รองรับ event มาไม่เรียงลำดับ, conditional update สำหรับ `firstMessageAt`, cleanup ใน test ที่จำกัดขอบเขตด้วย `runId` (ปลอดภัยกว่าที่ผมเขียนไว้เดิมซึ่ง `deleteMany({})`)

---

## 12.2 บั๊กที่เจอตอนรีวิว

### 🔴 A — ชื่อจริงของลูกค้าถูกลบทิ้งด้วยชื่อ LINE

```ts
// เดิม — updateLineCustomer()
if (input.profile.displayName) {
  set.lineDisplayName = input.profile.displayName;
  set.displayName = input.profile.displayName;   // ← ทับทุกครั้งที่มี event
}
```

`displayName` คือชื่อที่ระบบใช้แสดง ซึ่ง **ลูกค้าแก้เองได้ในฟอร์ม LIFF** (docs/08 ระบุชัดว่า LINE displayName มักไม่ใช่ชื่อจริง จึงต้องให้แก้)

**ผลที่เกิด:** ลูกค้ากรอก "สมชาย ใจดี" ในฟอร์ม → วันหลังส่งข้อความมาหา OA → ชื่อกลับไปเป็น "Somchai" เงียบ ๆ ไม่มี error ไม่มี log — เจอตอนที่พนักงานเปิดชีตแล้วสงสัยว่าทำไมชื่อเปลี่ยนเอง

**แก้:** แยกความรับผิดชอบของสอง field
- `lineDisplayName` = กระจกสะท้อน LINE → อัปเดตได้ตลอด
- `displayName` = ชื่อที่ระบบใช้ → **เติมเฉพาะตอนที่ยังว่าง** (fill-forward) ไม่ทับของเดิม

### 🟠 B — เส้นทาง `first_message` ไม่บันทึกโปรไฟล์

`if (first.modifiedCount === 1)` return ออกก่อนโดยไม่เรียก `updateLineCustomer` → `lineDisplayName` กับ `pictureUrl` ไม่ถูกเขียน

**ผลที่เกิด:** ลูกค้าที่ตอน follow ดึงโปรไฟล์ไม่ได้ (LINE Profile API ตอบ 404 เพราะผู้ใช้บล็อกบอทอยู่ — เคสที่ WF-A ตั้ง `Continue On Fail` ไว้รับมือ) แล้วมาทักทีหลัง จะไม่มีชื่อและไม่มีรูปตลอดไป

**แก้:** เรียก `updateLineCustomer` ในเส้นทางนี้ด้วย

> น่าสนใจ: บั๊ก B บังบั๊ก A ไว้ในเคสข้อความแรก — เทสที่ยิงข้อความครั้งเดียวจึงผ่าน ต้องยิงข้อความ **ครั้งที่สอง** ถึงจะเห็น

### 🟡 C — `resolveCustomer` เรียกตัวเองซ้ำได้ไม่จำกัด
retry ตอนชน duplicate key ไม่มีเพดาน — ปกติรอบถัดไปต้องเจอ identity แล้ว แต่ถ้ามีอย่างอื่นผิดจะวนจน function timeout **แก้:** ใส่เพดาน 3 ชั้น

### 🟡 D — route ไม่ส่ง `message.type` ต่อ
`upsertFromLine` รับ `message.type` แต่ route ไม่อ่านจาก body → `payload.messageType` เป็น `null` เสมอ **แก้:** อ่านและส่งต่อ

---

## 12.3 ผลทดสอบหลังแก้

**86 tests ผ่าน** (เพิ่ม regression 2 เคสสำหรับบั๊ก A และ B)

> ⚠️ integration test ต้องตั้ง `RUN_MONGO_INTEGRATION=true` ไม่งั้นถูกข้าม
> ตอนรีวิวพบว่าเทส S3 ทั้ง 5 เคส **ไม่เคยรันจริง** เพราะไม่ได้ตั้ง flag และ MongoDB ไม่ได้เปิด
> ```bash
> npm run db:test:up && RUN_MONGO_INTEGRATION=true npm test
> ```

**ยิง endpoint จริงผ่าน HTTP:**
```
✅ HMAC ผิด → 401
✅ timestamp เก่า 10 นาที → 401 (กัน replay)
✅ ข้อมูลไม่ครบ → 400
✅ eventType ไม่รองรับ → 400
✅ follow ใหม่ → 200 + สร้างลูกค้า
✅ ยิงซ้ำ event เดิม → ลูกค้าคนเดิม ไม่สร้าง interaction ซ้ำ
✅ ข้อความแรก → milestone first_message
✅ ข้อความที่สอง → ไม่มี milestone
```

**ลูกค้าที่ระบบสร้างบน Atlas จริง:**
```json
{ "displayName": "อี2อี ทดสอบ", "lineDisplayName": "อี2อี ทดสอบ",
  "customerStatus": "lead", "tags": ["line-follower", "engaged"], "sources": ["line"],
  "firstInteractionAt": "...", "firstMessageAt": "...",
  "counters": { "milestones": 2 }, "sheetSync": { "dirty": true } }

identities:   [{ provider: "line", channelId: "...", externalId: "U...", verified: true }]
interactions: [{ type: "follow" }, { type: "first_message", payload: { messageType: "text" } }]
```
(ลบข้อมูลทดสอบออกจาก dev cluster แล้ว)
