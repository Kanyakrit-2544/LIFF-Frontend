# Phase 9 — PII Scrubber / Restore เป็น Service

อ้างอิงของจริงใน `raw input/PII_Scrubber_Mac.command` + `PII_Restore_Mac.command`

---

## 9.1 ของเดิมทำงานยังไง

**Stack:** Microsoft Presidio (`presidio-analyzer` + `presidio-anonymizer`) + spaCy NER + custom Thai recognizers

**Entity ที่จับได้** (7 category)
| category | entities |
|---|---|
| `email` | `EMAIL_ADDRESS` |
| `card` | `CREDIT_CARD` |
| `address` | `LOCATION`, `TH_ADDRESS`, `TH_POSTCODE` |
| `phone` | `PHONE_NUMBER`, `TH_PHONE` |
| `id` | `TH_NATIONAL_ID`, `US_SSN` |
| `date` | `DATE_TIME` (ปิดเป็นค่าตั้งต้น) |
| `name` | `PERSON` |

**Thai recognizer ที่เขียนเอง** — regex เบอร์ไทย `0[689]xx-xxx-xxxx`, เลขบัตร 13 หลัก, ที่อยู่ไทย + 77 จังหวัด, รหัสไปรษณีย์, คำนำหน้าชื่อไทย, รายชื่อคนไทย (deny list) พร้อม logic พิเศษสำหรับ **ตาราง** (`column_results()` — เดา entity จากหัวคอลัมน์ เพราะ NER ต้องการบริบทประโยคซึ่งข้อมูลใน cell ไม่มี) ← จุดนี้ทำมาดี เข้ากับ Excel ของคุณพอดี

**Token format**
```
<ENTITY_TYPE_xxxx>       เช่น <TH_PHONE_a3f9>, <PERSON_7c21>
code = sha256(salt + "|" + entity_type + "|" + value)[:n]
```
✅ **deterministic** — ค่าเดียวกันได้ token เดียวกันเสมอ ทั้งในไฟล์เดียวและข้ามไฟล์ (salt เก็บถาวรใน `_maps/.salt`)
→ AI จึงรู้ว่า `<PERSON_7c21>` ในสองที่คือคนเดียวกัน โดยไม่รู้ว่าเป็นใคร **นี่คือคุณสมบัติที่ดีมากและต้องรักษาไว้**

**Map file** `_maps/<stem>.map.json`
```json
{ "source": "customers.xlsx", "salt": "…",
  "entries": { "<TH_PHONE_a3f9>": { "value": "0812345678", "type": "TH_PHONE", "category": "phone" } } }
```

**โฟลเดอร์ที่ใช้**
`_maps/` (map) → `input_ai_placeholder/` (ไฟล์ที่ scrub แล้ว ปลอดภัยส่งให้ AI) → `output_from_ai_placeholder/` (คำตอบจาก AI) → `Reverse_Data/` (คืนค่าจริงแล้ว)

---

## 9.2 ช่องว่างระหว่าง CLI กับ Service

| ประเด็น | ของเดิม (CLI) | ที่ service ต้องการ |
|---|---|---|
| Input | ไฟล์ในโฟลเดอร์ | JSON payload ผ่าน HTTP |
| Output | เขียนไฟล์ `_for_ai.md` | ตอบกลับใน response |
| Map | ไฟล์ `.map.json` บนดิสก์ | `pii_tokens` ใน Mongo + TTL |
| Salt | ไฟล์ `.salt` ต่อโฟลเดอร์ | env `PII_SCRUB_SALT` ตัวเดียวทั้งระบบ |
| เลือก category | ถาม checklist ทาง stdin | ส่งมาใน request |
| ค่าจริงใน map | **plaintext ใน JSON** | ⚠️ ต้องเข้ารหัส (ดู 9.4) |
| Cold start | โหลด spaCy ~500MB | ⚠️ ปัญหาใหญ่บน serverless (ดู 9.5) |

---

## 9.3 สิ่งที่ต้องแก้ในโค้ดเดิม — น้อยมาก

ฟังก์ชันหลัก `scrub(text, entities, language, tabular, salt, taken)` **รับ string คืน string อยู่แล้ว** ไม่ผูกกับไฟล์
งานที่ต้องทำจึงเป็นแค่ **แกะ core ออกจาก CLI wrapper**:

```
services/pii/
├── lib/
│   ├── recognizers.py    # ⬅️ ยกมาทั้งดุ้น: CATEGORIES, THAI_*, custom Pattern (บรรทัด ~85–210)
│   ├── analyzer.py       # ⬅️ analyze_all(), column_results(), make_code(), scrub()
│   ├── restore.py        # ⬅️ restore_text() จาก PII_Restore_Mac.command
│   └── vault.py          # 🆕 อ่าน/เขียน pii_tokens แทนไฟล์ .map.json
├── api/
│   ├── scrub.py          # 🆕 HTTP handler
│   └── restore.py        # 🆕 HTTP handler
├── cli.py                # 🆕 ยังใช้แบบเดิมได้ (สำหรับ import Excel ครั้งเดียว)
└── requirements.txt
```

**สำคัญ: อย่าทิ้งโหมด CLI** — ตอน import `Inner.xlsx` 10,998 แถวครั้งเดียว การรัน local เร็วกว่าและถูกกว่ายิง HTTP หมื่นครั้งมาก

**สิ่งที่ต้องแทนที่**
| เดิม | ใหม่ |
|---|---|
| `load_or_create_salt()` อ่านไฟล์ | `os.environ["PII_SCRUB_SALT"]` |
| `choose_categories()` ถาม stdin | `request.json["categories"]` |
| `json.dump(mapping, map_file)` | `vault.save(jobId, mapping)` → Mongo (เข้ารหัสก่อน) |
| `load_maps(folder)` | `vault.load(jobId)` |
| `taken = {}` ต่อ run | โหลด token ที่เคยออกให้ `customerId` นี้มาก่อน → token คงที่ข้าม job |

---

## 9.4 ⚠️ ช่องโหว่ในของเดิมที่ต้องปิด

**1. `.map.json` เก็บค่าจริงเป็น plaintext**
ไฟล์นี้คือ "กุญแจ" ที่ถอด PII กลับได้ทั้งหมด วางไว้ข้าง ๆ ไฟล์ที่ scrub แล้ว — ถ้าเผลอ zip ทั้งโฟลเดอร์ส่งให้ใคร = ข้อมูลรั่วทั้งชุด
→ **service ต้องเก็บ `valueEnc` (AES-256-GCM) เท่านั้น** และ `PII_KEY` อยู่คนละที่กับ database

**2. Salt อยู่ในไฟล์เดียวกับ map**
`_maps/.salt` — ใครอ่าน map ได้ก็อ่าน salt ได้ → brute-force ค่าที่เดาง่าย (เบอร์โทรมีแค่ ~10^8 แบบ) ได้
→ ย้ายไป env var แยก, **ห้ามเก็บ salt ลง Mongo คู่กับ token**

**3. Restore ไม่มีการตรวจสิทธิ์**
CLI ถือว่าใครรันไฟล์ได้ = มีสิทธิ์ แต่พอเป็น HTTP ต้องตรวจ
→ `/api/pii/restore` ต้องเช็ค HMAC + `jobId` เป็นของ caller + **log ทุกครั้งที่ restore** (ไม่งั้นกลายเป็น PII oracle: ยิง token สุ่มเพื่อดึงข้อมูลจริงออกมา)

**4. ไม่มี TTL**
map ค้างในโฟลเดอร์ตลอดไป → `pii_tokens` ต้องมี `expiresAt` + TTL index (ตั้งไว้แล้วใน docs/02)

---

## 9.5 ปัญหา Deploy: spaCy 500MB บน Vercel

Vercel Python function มีเพดานขนาด bundle (~250MB unzipped) — **spaCy + Presidio + language model ใส่ไม่ลง**

| ทางเลือก | ข้อดี | ข้อเสีย |
|---|---|---|
| **A. Cloud Run / Railway container** ⭐ | ไม่จำกัดขนาด, warm ได้, มี GPU ถ้าอยากได้ทีหลัง | ต้องดูแลอีก service, มีค่าใช้จ่าย |
| B. รันใน n8n host เดียวกัน (Docker sidecar) | ใช้เครื่องที่มีอยู่แล้ว, ไม่มีค่าใช้จ่ายเพิ่ม | ผูกกับ n8n uptime; n8n ล่ม = PII service ล่ม |
| C. Vercel + regex-only (ตัด spaCy ออก) | เบา, deploy ที่เดียว | **ตรวจชื่อคนไทยได้แย่ลงมาก** — PERSON พึ่ง NER เป็นหลัก |
| D. รัน CLI แบบ batch อย่างเดียว ไม่ทำ service | ง่ายสุด, ปลอดภัยสุด | ใช้ real-time ไม่ได้ |

**เจ้าของงานกำหนดแล้วว่า scrub อยู่ในเส้นทางหลัก** (`ได้ข้อมูล → scrub → AI ใน n8n → Sheets`)
→ **D ใช้ไม่ได้** ต้องเป็น service จริงตั้งแต่ก่อน S8

**เลือกแล้ว: A — container แยก** (ทำเป็นแบบจำลองให้เหมือนใช้งานจริง)

```
services/pii/Dockerfile        → FastAPI + presidio + spaCy
docker-compose.yml             → service `pii` แยกจาก `n8n` คนละ container
                                 dev: http://pii:8000 (n8n เรียกผ่าน docker network)
                                 prod: Cloud Run / Railway — เปลี่ยนแค่ PII_SERVICE_URL
```
ตอน dev อยู่ compose เดียวกันได้ แต่**แยก container** → ย้ายขึ้น cloud ทีหลังไม่ต้องแก้โค้ด

---

## 9.6 จุดที่จะใช้จริงในโปรเจกต์นี้

| ที่ | ใช้ทำอะไร | เฟส |
|---|---|---|
| **WF-C ก่อนเขียน Google Sheets** ⭐ | scrub ข้อมูลลูกค้า → ส่งให้ AI ใน n8n → restore → เขียน Sheets | **สโคปนี้** |
| Facebook Lead Ads | scrub ก่อน enrich | เฟส 2 |

**ผลต่อลำดับ implement:** `services/pii` ต้องเสร็จ **ก่อน S8** (Sheets sync) ไม่ใช่ S10
ลำดับใหม่: … → S7 (form submit) → **S8a services/pii** → S8b WF-C + AI → S9

---

## 9.7 ทดสอบ

- [ ] scrub → restore ได้ข้อความเดิม 100% (round-trip)
- [ ] ค่าเดียวกันในสองไฟล์ → token เดียวกัน (deterministic)
- [ ] salt ต่างกัน → token ต่างกัน
- [ ] เบอร์ไทยทุกรูปแบบ `0812345678` / `081-234-5678` / `081 234 5678` / `+66812345678` ถูกจับครบ
- [ ] เลขบัตรประชาชน 13 หลักทั้งมีขีดและไม่มีขีด
- [ ] ตาราง/CSV — หัวคอลัมน์ "เบอร์" ทำให้ค่าในคอลัมน์นั้นถูกจับแม้ไม่มีบริบท
- [ ] `pii_tokens` ไม่มี plaintext (`db.pii_tokens.findOne()` ตรวจด้วยตา)
- [ ] restore ด้วย `jobId` ของ caller อื่น → `403` + มี log
- [ ] token หมดอายุ → restore ไม่ได้ ตอบ error ที่เข้าใจได้ (ไม่ใช่ 500)
