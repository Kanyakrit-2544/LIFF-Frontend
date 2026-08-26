# Phase 10 — MongoDB Compression

## 10.1 ทำสองชั้น

| ชั้น | ตั้งที่ไหน | ลดอะไร |
|---|---|---|
| **Network** | connection string / driver options | bandwidth ระหว่าง Vercel ↔ Atlas |
| **Storage (WiredTiger block)** | ตอน `createCollection` | ขนาดบนดิสก์ + I/O |

---

## 10.2 Network Compression

```ts
new MongoClient(uri, { compressors: ["zstd", "zlib"], zlibCompressionLevel: 6 })
```
ตั้งผ่าน env: `MONGODB_COMPRESSORS=zstd,zlib`

- driver เจรจากับ server แล้วเลือกตัวแรกที่ทั้งสองฝั่งรองรับ
- `zstd` ต้องมี package `@mongodb-js/zstd` (native, มี prebuilt สำหรับ linux-x64 = runtime ของ Vercel) — ติดตั้งไว้แล้ว
- `zlib` เป็น fallback ที่มีใน Node เสมอ ไม่ต้องลง native module
- ถ้า deploy แล้วเจอปัญหา native module บน Vercel → เปลี่ยน env เป็น `MONGODB_COMPRESSORS=zlib` อย่างเดียว ไม่ต้องแก้โค้ด

**ทำไมสำคัญกับสถาปัตยกรรมนี้:** Vercel serverless เรียก Atlas ข้ามเน็ต ทุก request มี round-trip จริง — ต่างจากแอปที่รันข้าง ๆ database

---

## 10.3 Storage Compression

```ts
db.createCollection(name, {
  storageEngine: { wiredTiger: { configString: "block_compressor=zstd" } }
})
```
ตั้งผ่าน env: `MONGODB_BLOCK_COMPRESSOR=zstd` (`zstd` | `snappy` | `zlib` | `none`)

⚠️ **ตั้งได้ตอนสร้าง collection เท่านั้น** — เปลี่ยนทีหลังต้องสร้างใหม่แล้วย้ายข้อมูล
จึงต้องรัน `npm run create-indexes` **ก่อน**เขียนข้อมูลจริงลงฐานใหม่ทุกครั้ง

### ✅ ยืนยันจากคลัสเตอร์จริงแล้ว: Atlas ไม่อนุญาต

รันกับ `line-crm-dev` (Atlas, MongoDB 8.0.29):
```
parameter storageEngine is disallowed in create command
```
ทุก collection → `ensureCollection()` จับ error แล้วสร้างแบบ default ต่อ **ไม่พังทั้งสคริปต์**
ผลลัพธ์: collection ครบ 8, index ครบ 24 ตัว

**แปลว่าบน Atlas ได้ storage compression เป็น `snappy` (ค่า default) ไม่ใช่ `zstd`**
ส่วน **network compression `zstd` ยังทำงานปกติ** เพราะเป็นฝั่ง driver ไม่เกี่ยวกับสิทธิ์ของ cluster

| อยากได้ zstd บน storage ด้วย | ต้องทำ |
|---|---|
| Atlas | อัปเป็น **dedicated tier (M10+)** ซึ่งเปิด `storageEngine` ให้ |
| Self-host / Docker | ได้เลย ไม่มีข้อจำกัด |
| **ไม่ทำอะไร** | ได้ snappy — ยังบีบอยู่ แค่ไม่ดีที่สุด **เพียงพอสำหรับ POC** |

`MONGODB_BLOCK_COMPRESSOR=zstd` ทิ้งไว้ได้ ไม่มีผลเสีย — พอย้ายไป M10 หรือ self-host จะมีผลทันทีโดยไม่ต้องแก้อะไร

---

## 10.4 วัดจริง

20,000 documents โครงสร้างตาม `customers` (docs/02) บน MongoDB 7 (Docker — ที่ตั้ง compressor ได้):

| compressor | logical | บนดิสก์ | ratio |
|---|---|---|---|
| **zstd** | 27.66 MB | **1.01 MB** | 27.4x |
| zlib | 27.66 MB | 1.01 MB | 27.3x |
| snappy *(default ของ MongoDB/Atlas)* | 27.66 MB | 2.96 MB | 9.3x |
| ไม่ระบุ | 27.66 MB | 2.96 MB | 9.3x → **ยืนยันว่า default = snappy** |

**zstd เล็กกว่า snappy ~2.9 เท่า**

> ⚠️ **อ่านตัวเลขนี้อย่างระวัง** — ข้อมูลทดสอบเป็นค่าที่ซ้ำกันมาก (`"a".repeat(64)` เป็น hash จำลอง)
> ทำให้อัตราส่วนสูงเกินจริงทั้งกระดาน ข้อมูลลูกค้าจริงจะได้ ratio ต่ำกว่านี้มาก
> สิ่งที่ตัวเลขนี้ยืนยันได้จริงคือ **ลำดับ**: zstd ≈ zlib < snappy และ default คือ snappy

**เลือก zstd เพราะ** อัตราบีบดีกว่า snappy ชัดเจน ขณะที่เร็วกว่า zlib มากในการคลาย (zlib ได้ขนาดพอกันแต่ CPU สูงกว่า)

---

## 10.5 ดูผลจริงบนฐานของตัวเอง

```bash
npm run create-indexes
```
ท้ายสคริปต์รายงานให้ทุก collection:
```
customers  docs=  20000  logical=27.66MB  disk=1.01MB  ratio=27.44x  compressor=zstd
```

`ratio=-` และ `disk` เป็น 0 แปลว่ายังไม่ checkpoint (ข้อมูลเพิ่งเขียน) — ปกติสำหรับ collection ว่าง

---

## 10.6 สิ่งที่ compression **ไม่ได้**ช่วย

- ❌ ไม่ลดการใช้ RAM — WiredTiger cache เก็บข้อมูลแบบคลายแล้ว
- ❌ ไม่ลดขนาด index มากนัก (index ใช้ prefix compression คนละกลไก เปิดอยู่แล้วโดย default)
- ❌ ไม่ทดแทนการไม่เก็บข้อมูลที่ไม่จำเป็น — D4 (ไม่เก็บบทสนทนา) ยังสำคัญกว่า
