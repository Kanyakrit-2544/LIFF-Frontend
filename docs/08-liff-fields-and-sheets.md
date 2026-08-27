# Phase 8 — โครงสร้างข้อมูลลูกค้า + ฟอร์ม LIFF

> **สโคปงานนี้:** เก็บข้อมูลลูกค้าจาก **การแอดเพื่อน + การทักครั้งแรก** แล้วให้กรอกเพิ่มผ่าน LIFF
> `Inner.xlsx` เป็น**ไฟล์ลูกค้าที่ซื้อแล้ว** — ใช้ดู **โครงสร้าง field เท่านั้น** ไม่อยู่ในสโคปนี้

---

## 8.1 ⚠️ ข้อจำกัดของ LINE ที่กระทบการตัดสินใจ

คุณระบุว่าให้ **เบอร์ / อีเมล / วันเกิด ดึงจาก LIFF เลย ไม่ต้องให้กรอก แล้วแสดงโชว์**
**LINE ไม่เปิด API ให้ดึงข้อมูลเหล่านี้** — ต้องแก้แผนตรงนี้

| ข้อมูล | LINE ให้ไหม | รายละเอียด |
|---|---|---|
| `userId`, `displayName`, `pictureUrl`, `statusMessage` | ✅ | `liff.getProfile()` ได้ครบ |
| **เบอร์โทร** | ❌ **ไม่มี API ใด ๆ** | ไม่ว่า scope ไหน LINE ไม่เปิดเผยเบอร์ให้ third-party |
| **วัน/เดือน/ปีเกิด** | ❌ **ไม่มี API** | LINE ไม่เก็บ/ไม่เปิดเผย |
| **อีเมล** | 🟡 **มีเงื่อนไข** | ได้จาก `email` claim ใน ID Token แต่ต้อง:<br/>1. ยื่นขอ **Email permission** ใน LINE Developers Console (แนบ privacy policy + หน้าจอขอความยินยอม รออนุมัติ)<br/>2. ผู้ใช้กดยินยอมตอน login<br/>3. ผู้ใช้ต้องผูกอีเมลกับ LINE ไว้ — **หลายคนไม่ได้ผูก** → ได้ค่าว่าง |

### ผลที่ตามมา

| Field | ต้องทำยังไง |
|---|---|
| `phone` | **ให้ลูกค้ากรอก** — ไม่มีทางอื่น 🔑 required (เป็น identity key หลัก) |
| `birthYear` | **ให้ลูกค้ากรอก** — dropdown ปี พ.ศ. (ตามที่คุณเลือก) |
| `email` | **กรอกเอง** แต่ **prefill อัตโนมัติ**ถ้าได้จาก ID Token → ตรงกับเจตนา "ลดขั้นตอนลูกค้า" มากที่สุดเท่าที่ LINE ยอมให้ |

**เรื่องที่ต้องตัดสิน:** จะยื่นขอ Email permission กับ LINE ไหม
- **ยื่น** → ลูกค้าส่วนหนึ่งไม่ต้องพิมพ์อีเมล แลกกับรอ LINE อนุมัติ + ต้องมี privacy policy ขึ้นเว็บ
- **ไม่ยื่น** → ให้กรอกเองทุกคน เริ่มงานได้ทันที

ผมไม่เลือกให้ — ทั้งสองทางฟอร์มออกแบบเหมือนกัน ต่างแค่ว่ามีค่า prefill หรือไม่

---

## 8.2 โครงสร้าง Field (สรุปตามที่คุณตัดสินแล้ว)

| Field | ที่มา | required | สถานะ |
|---|---|---|---|
| `fullNameTh` | ลูกค้ากรอก (prefill จาก LINE displayName) | ✅ | ✔ ยืนยัน |
| `nickname` | ลูกค้ากรอก | | ✔ ยืนยัน |
| `fullNameEn` | ลูกค้ากรอก | | ✔ ยืนยัน |
| `birthYear` | ลูกค้ากรอก — **ปี พ.ศ.** | | ✔ ยืนยัน (แก้จาก "อายุ" ของไฟล์เดิม) |
| `phone` | ลูกค้ากรอก | ✅ | ⚠️ แก้จาก "ดึงเอง" → กรอก (§8.1) |
| `email` | ลูกค้ากรอก + prefill ถ้าได้ | | ⚠️ แก้จาก "ดึงเอง" → กรอก+prefill (§8.1) |
| `facebook` | ลูกค้ากรอก | | ✔ ยืนยัน — แยกช่อง ไม่บังคับ |
| `instagram` | ลูกค้ากรอก | | ✔ ยืนยัน — แยกช่อง ไม่บังคับ |
| `consentDataProcessing` | checkbox | ✅ | ✔ ยืนยัน |
| `consentMarketing` | checkbox | | ✔ ยืนยัน |

**ระบบสร้างเอง (ไม่ถามลูกค้า):** `customerId`, `lineUserId`, `lineDisplayName`, `pictureUrl`, `firstInteractionAt` (วันแอด), `firstMessageAt` (วันทักครั้งแรก), `source`, `createdAt`

---

## 8.3 ฟอร์ม LIFF

### Section 1 — ข้อมูลจาก LINE (แสดงอย่างเดียว)
`pictureUrl` (รูป) · `lineDisplayName` (readonly)

### Section 2 — ข้อมูลลูกค้า
`fullNameTh` ✅ · `nickname` · `fullNameEn` · `birthYear` (select พ.ศ.) · `phone` ✅ · `email` (prefill ถ้ามี)

### Section 3 — ช่องทางอื่น (ไม่บังคับ)
`facebook` · `instagram`
> แยก 3 ช่องตามที่คุณเลือก (LINE ระบบรู้เองอยู่แล้ว) — เตรียม match Meta ในเฟส 2

### Section 4 — PDPA
`consentDataProcessing` ✅ · `consentMarketing`

ทุก field กำหนดใน `form_schemas` collection → เพิ่ม/แก้คำถามได้โดยไม่ต้อง deploy

---

## 8.4 Google Sheets Layout

แท็บ `Customers` — 1 แถว = 1 คน · **แสดงเต็มไม่ mask** จาก plaintext ใน DB หลัก

| Col | Column ID | Header | ที่มา |
|---|---|---|---|
| A | `customerId` | Customer ID | ระบบ — 🔒 row key ห้ามแก้/ลบ |
| B | `fullNameTh` | ชื่อ-นามสกุล | LIFF |
| C | `nickname` | ชื่อเล่น | LIFF |
| D | `fullNameEn` | Name Eng. | LIFF |
| E | `birthYear` | ปีเกิด (พ.ศ.) | LIFF |
| F | `phone` | เบอร์ | LIFF |
| G | `email` | อีเมล | LIFF |
| H | `lineDisplayName` | LINE ชื่อ | LINE API |
| I | `facebook` | Facebook | LIFF |
| J | `instagram` | Instagram | LIFF |
| K | `status` | สถานะ | ระบบ — lead / inactive |
| L | `source` | Source | ระบบ — line |
| M | `firstInteractionAt` | วันที่แอดเพื่อน | ระบบ |
| N | `firstMessageAt` | วันที่ทักครั้งแรก | ระบบ |
| O | `formSubmittedAt` | วันที่กรอกฟอร์ม | ระบบ |
| P | `consent` | PDPA | ระบบ — ✅/❌ + วันที่ |
| Q | `updatedAt` | อัปเดตล่าสุด | ระบบ |
| **R** | `staffNote` | **หมายเหตุพนักงาน** | 👤 staff — ⚠️ **ระบบไม่แตะ** |

> **Column ID คือสิ่งที่ AI ใช้ match** (ข้อ 2 ที่คุณตอบ) — คุณกำหนด/เปลี่ยนชุดนี้ได้ AI จะจับคู่ตามนี้
> เก็บ ID ไว้ใน **แถว 1 ของแท็บ `_Schema`** เพื่อให้แก้ได้โดยไม่ต้อง deploy — ดู docs/04

แท็บ `_Log` — บันทึกทุกรอบ sync (เวลา, จำนวนแถว, error)
แท็บ `_Schema` — Column ID ที่ AI ใช้ match

---

## 8.5 นอกสโคป (ไว้คิดทีหลัง)

ประวัติการซื้อ/คอร์ส · ข้อมูลการเงิน (`Slip No.`, ยอดชำระ, ส่วนลด) · `Sale` เจ้าของลูกค้า · ใบเสร็จ/ใบกำกับภาษี · การ import ไฟล์ลูกค้าเดิม

**บันทึกไว้เผื่อตอนนั้น:** ไฟล์มี ~4,907 เบอร์ unique จาก 10,998 แถว → ลูกค้าซ้ำ 1,648 คน (สูงสุด 13 ครั้ง/คน) ต้องมีแผน dedupe
