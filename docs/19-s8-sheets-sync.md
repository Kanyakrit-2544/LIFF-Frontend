# S8 — Google Sheets Sync

## 19.1 เลือกไม่ใช้ AI (แก้ D10, D11, D13)

เจ้าของงานเลือกแบบ **A — map ตรงจาก Column ID** เพราะคอลัมน์ในชีตไม่เปลี่ยน

ผลที่ตามมาโดยตรง: **ไม่ต้องมี scrub/restore ในเส้นทางนี้**
D9 กำหนด `Mongo → scrub → AI → restore → Sheets` แต่ scrubber มีไว้กัน PII ไม่ให้ถึง AI
ไม่มี AI = ไม่มีอะไรต้องกัน การใส่ไว้เฉย ๆ มีแต่เพิ่มชิ้นส่วนที่ถือ PII token โดยไม่ได้ประโยชน์

เหลือ `Mongo → toSheetRow → Sheets` และ `services/pii` กลับไปเป็นงานเฟส AI ในอนาคต

| # | เดิม | ใหม่ |
|---|---|---|
| D9 | scrub → AI → restore → Sheets | **Mongo → Sheets ตรง** |
| D10 | AI จับคู่ข้อมูลกับ Column ID | **map ตรงจาก `SHEET_COLUMNS`** |
| D11 | OpenAI / ChatGPT | **ไม่ใช้** |
| D13 | flow LINE ไม่ผ่าน AI | ไม่มี AI ทั้งระบบ |

---

## 19.2 สิ่งที่สร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| `customers/toSheetRow.ts` | นิยามคอลัมน์ + แปลง customer เป็นแถว |
| `customers/sheetQueue.ts` | จองงาน/ปิดงาน/ปลด lock ที่ค้าง |
| `api/internal/sheets/pending` | n8n มาดึงแถวที่รอซิงก์ |
| `api/internal/sheets/ack` | ปิดงาน + นับ attempts |
| `scripts/setup-sheet.ts` | สร้างแท็บ + หัวตาราง (`npm run setup:sheet`) |
| `scripts/lib/googleAuth.ts` | service account → access token |
| `workflows/WF-C-sheets-sync.json` | n8n 11 node |

**นิยามคอลัมน์อยู่ที่เดียว** — `SHEET_COLUMNS` ใน `toSheetRow.ts`
หัวตาราง, การเขียนแถว และสคริปต์ตั้งค่าชีต อ่านจากก้อนนี้ทั้งหมด เพิ่มคอลัมน์แก้ที่เดียวจบ

22 คอลัมน์: A `customerId` … U `อัปเดตล่าสุด` · **V `หมายเหตุพนักงาน`**

ไม่ส่ง `customerStatus` และ `source.channel` ไป Sheet แล้ว ข้อมูลสองตัวนี้อยู่ใน MongoDB สำหรับระบบภายในเท่านั้น

⚠️ `staffNote` ต้องเป็นตัวสุดท้ายเสมอ — ระบบเขียนถึงแค่ A–U มี test คุมไว้

---

## 19.3 ทำไมไม่ sync ทันทีที่ข้อมูลเปลี่ยน

- Sheets API จำกัดราว 60 write/นาที — ชนเพดานง่ายตอนคนกรอกพร้อมกัน
- read-then-write ของ Sheets ไม่ atomic → สอง worker พร้อมกัน = **แถวซ้ำ**

จึงตั้งธง `sheetSync.dirty` แล้วให้ n8n กวาดเป็นชุดทุก 2 นาที
`values:batchUpdate` ครั้งเดียวเขียนได้ทั้งการแก้แถวเดิมและเพิ่มแถวใหม่ — ไม่ต้องแยก append

**กันสอง worker หยิบแถวเดียวกัน:** หา id ก่อน (limit) แล้ว `updateMany` เฉพาะตัวที่ `lockedAt: null`
worker ที่มาทีหลัง match 0 · lock ค้างเกิน 5 นาทีถูกปลดอัตโนมัติ

---

## 19.4 ผลทดสอบจริง

**175 tests ผ่าน** (core 129 + web 46) — เพิ่ม 13 เคสสำหรับ `toSheetRow`

รัน n8n จริงกับ Google Sheet จริง:

**รอบแรก — เพิ่มแถวใหม่**
```
ลูกค้า 3 คน dirty → รอ cron → ชีตมี 4 แถว (รวมลูกค้าจริง 1 คน)
ปีเกิด 2535 → คอลัมน์อายุแสดง 34 (คำนวณตอน sync ไม่ต้องแก้ทุกปี)
PDPA → "✓ 2026-08-27"
⚠️ เบอร์ซ้ำ รอตรวจ → cus_ตัวอย่าง (ธงจาก docs/18 โผล่ให้พนักงานเห็น)
```

**รอบสอง — แก้ข้อมูลเดิม (ข้อสำคัญที่สุด)**
```
1. เขียนหมายเหตุพนักงานที่ V3 "พนักงานจดไว้: โทรแล้ว 27/8"
2. เปลี่ยนชื่อเล่นใน Mongo เป็น "ชายใหม่" แล้วตั้ง dirty
3. รอ sync

ผล: R3 ชื่อเล่น=ชายใหม่  หมายเหตุ=พนักงานจดไว้: โทรแล้ว 27/8
     แถวรวม 4 แถวเท่าเดิม
```
✅ อัปเดตในแถวเดิม **ไม่สร้างแถวซ้ำ** และ **ไม่ทับหมายเหตุพนักงาน** — RISK-4 ปิด

**S9 update:** หลังเปลี่ยน DB หลักเป็น plaintext แล้ว `toSheetRow()` เขียนเบอร์/อีเมลเต็มจาก `customers.phone` / `customers.email` โดยตรง
จึงไม่มี fallback decrypt/mask และต้องลบข้อมูลเก่าก่อน deploy เพื่อกันค่า object เก่าไปโผล่ในชีต

---

## 19.5 ตั้งค่า n8n

`.env` ที่รากโปรเจกต์ต้องมีเพิ่ม:
```bash
GOOGLE_SHEET_ID=<id จาก URL ของ sheet>
# ทั้งไฟล์ service account JSON บีบเป็นบรรทัดเดียว
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```
บีบไฟล์:
```bash
python3 -c "import json;print(json.dumps(json.load(open('sa.json')),separators=(',',':')))"
```

WF-C แลก access token เองใน Code node (RS256) — **ไม่ต้องตั้ง credential ใน n8n UI**
ทำให้ workflow ทำงานได้ทันทีหลัง import โดยไม่ต้องคลิกอะไรเพิ่ม

**import:**
```bash
cd "/Users/kanyakritbowornsuwan/Desktop/Claude Code/line-crm" && docker cp workflows/WF-C-sheets-sync.json line-crm-n8n:/tmp/wfc.json && docker exec line-crm-n8n n8n import:workflow --input=/tmp/wfc.json && docker exec line-crm-n8n n8n update:workflow --id=wfc-sheets-sync --active=true && docker compose restart n8n
```

---

## 19.6 ยังไม่ได้ทำ

- **ลบแถวเมื่อลูกค้าถูก merge** — tombstone ยังค้างในชีต ควรเขียนว่า `MERGED → cus_xxx`
- แท็บ `_Log` และ `_Schema` เป็นของ flow เก่าและถูกลบได้ด้วย `npm run setup:sheet`
