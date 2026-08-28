#!/usr/bin/env python3
"""
ดึง "รูปทรงสถิติ" ของชีตขายจริงออกมาเป็น profile JSON โดยไม่เอา PII ติดมาด้วย

เครื่องมือรันมือครั้งเดียว ไม่ได้อยู่ใน npm test — ผลลัพธ์ถูก commit ไว้แล้ว
รันใหม่เมื่อชีตต้นทางเปลี่ยน:
    python3 scripts/legacy/profile_xlsx.py "raw input/Inner.xlsx" Inner2025 Inner2026

สิ่งที่ออกมามีแต่ตัวนับ/สัดส่วน/ช่วงค่า — ไม่มีชื่อ เบอร์ อีเมล หรือค่าจากเซลล์ที่ระบุตัวคนได้
"""
import json, re, sys, collections, datetime, statistics

import openpyxl

OUT = "packages/core/src/legacy/profile.json"

# หัวคอลัมน์ในชีต → field กลาง (เทียบแบบ "ขึ้นต้นด้วย" หลัง normalize)
FIELD_HEADERS = {
    "no": ["no."],
    "paidAt": ["date", "วัน/เดือน/ปี ที่ชำระ"],
    "expiresAt": ["end date", "วันที่หมดเขต"],
    "slipNo": ["slip no.", "เลขที่สลิป"],
    "fullNameTh": ["ชื่อ - นามสกุล", "ชื่อ-นามสกุล"],
    "fullNameEn": ["name eng"],
    "nickname": ["ชื่อเล่น"],
    "age": ["อายุ"],
    "phone": ["เบอร์"],
    "social": ["fb/line/ig"],
    "email": ["email"],
    "amount": ["ยอดชำระ"],
    "saleRep": ["sale"],
    "note": ["หมายเหตุ", "note1", "crm"],
    "receipt": ["ใบเสร็จ", "ส่งใบเสร็จ", "ที่อยู่"],
}
NON_COURSE = set(FIELD_HEADERS) 

def norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()

# คำไทยที่เป็น "ศัพท์ธุรกิจ" ไม่ใช่ชื่อคน — ป้ายรอบเรียนที่มีคำนอกรายการนี้ถือว่าอาจมีชื่อคนปน
SAFE_TH = [
    "หนังสือ", "ห้องพัก", "พักเดี่ยว", "คืนเงิน", "ค่าปรับ", "ย้ายเรียน", "ย้ายไป",
    "เพิ่ม", "เลื่อน", "ตัดสิทธิ", "ผ้าคลุม", "เรียนแทน", "ปรับ", "เปลี่ยนเป็น", "สิทธิ", "อื่น ๆ", "อื่นๆ", "คน",
]

def safe_label(label):
    """ป้ายรอบเรียนบางช่องมีชื่อคนจริงเขียนแทรกไว้ เช่น '8-9 Mar คุณ<ชื่อ> เรียนแทน'
    profile.json ถูก commit ลง repo จึงต้องไม่มี PII หลุดเข้าไปแม้แต่ตัวเดียว"""
    s = re.sub(r"คุณ.*$", "คุณ<ชื่อ> เรียนแทน" if "เรียนแทน" in label else "คุณ<ชื่อ>", label).strip()
    rest = s
    for w in SAFE_TH:
        rest = rest.replace(w, "")
    rest = rest.replace("<ชื่อ>", "")
    if re.search(r"[\u0E00-\u0E7F]", rest):
        return "«ข้อความอื่น»"
    return s

def field_of(header):
    h = norm(header).lower()
    if not h:
        return None
    for field, prefixes in FIELD_HEADERS.items():
        for p in prefixes:
            if h.startswith(p):
                return field
    return None

def norm_phone(v):
    if v is None:
        return None
    s = norm(v)
    if s.endswith(".0"):
        s = s[:-2]
    d = re.sub(r"\D", "", s)
    if not d:
        return None
    if d.startswith("66") and len(d) == 11:
        d = d[2:]
    elif d.startswith("0"):
        d = d[1:]
    if len(d) == 9 and d[0] in "689":
        return "+66" + d
    if len(d) == 8 and d[0] in "23456789":
        return "+66" + d
    return None

def as_date(v):
    if isinstance(v, datetime.datetime):
        return v.date()
    if isinstance(v, datetime.date):
        return v
    return None

def as_amount(v):
    if v is None:
        return None
    s = norm(v).replace(",", "")
    try:
        n = float(s)
    except ValueError:
        return None
    return n if n > 0 else None

def profile_sheet(ws, name):
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    header_i = next(i for i, r in enumerate(rows[:8]) if any("นามสกุล" in norm(c) for c in r))
    header = rows[header_i]

    cols, courses = {}, []
    for j, cell in enumerate(header):
        h = norm(cell)
        if not h:
            continue
        f = field_of(h)
        if f:
            cols.setdefault(f, j)
        elif h not in ("",):
            courses.append({"index": j, "label": h})

    n = 0
    have = collections.Counter()
    ages, amounts, months, per_row_courses = [], [], collections.Counter(), collections.Counter()
    course_hits = collections.Counter()
    course_sessions = collections.defaultdict(collections.Counter)
    sale_reps = collections.Counter()
    phone_rows = collections.Counter()   # เบอร์ -> จำนวนแถว (ใช้หาอัตราซื้อซ้ำ ไม่เก็บตัวเบอร์)
    slip_rows = collections.Counter()

    for i, r in enumerate(rows[header_i + 1 :], start=header_i + 2):
        def cell(f):
            j = cols.get(f)
            return r[j] if j is not None and j < len(r) else None

        if not norm(cell("fullNameTh")):
            continue
        n += 1

        for f in ("fullNameEn", "nickname", "social", "email"):
            if norm(cell(f)):
                have[f] += 1

        ph = norm_phone(cell("phone"))
        if ph:
            have["phone"] += 1
            phone_rows[ph] += 1

        try:
            a = int(float(norm(cell("age"))))
            if 10 <= a <= 90:
                ages.append(a)
                have["age"] += 1
        except (ValueError, TypeError):
            pass

        amt = as_amount(cell("amount"))
        if amt:
            amounts.append(amt)
            have["amount"] += 1

        d = as_date(cell("paidAt"))
        if d:
            months[d.month] += 1
            have["paidAt"] += 1

        slip = norm(cell("slipNo"))
        if slip:
            slip_rows[slip] += 1
            have["slipNo"] += 1

        rep = norm(cell("saleRep"))
        if rep:
            sale_reps[rep] += 1

        hits = 0
        for c in courses:
            v = norm(r[c["index"]]) if c["index"] < len(r) else ""
            if v:
                hits += 1
                course_hits[c["label"]] += 1
                course_sessions[c["label"]][safe_label(v)] += 1
        per_row_courses[hits] += 1

    def q(xs):
        if not xs:
            return None
        xs = sorted(xs)
        return {
            "min": xs[0], "p25": xs[len(xs) // 4], "median": statistics.median(xs),
            "p75": xs[(len(xs) * 3) // 4], "max": xs[-1], "mean": round(statistics.mean(xs), 2),
        }

    repeat = collections.Counter(phone_rows.values())

    return {
        "sheet": name,
        "headerRow": header_i,
        "columns": cols,
        "courseColumns": courses,
        "rows": n,
        "fillRate": {k: round(v / n, 4) for k, v in have.items()} if n else {},
        "age": q(ages),
        "amount": q(amounts),
        "amountBuckets": _buckets(amounts),
        "monthWeights": {str(m): months[m] for m in sorted(months)},
        "coursesPerRow": {str(k): v for k, v in sorted(per_row_courses.items())},
        "courseHits": dict(course_hits.most_common()),
        # ป้ายรอบเรียนผ่าน safe_label() แล้ว — ชื่อคนถูกแทนที่ด้วย placeholder
        "courseSessions": {k: dict(v.most_common()) for k, v in course_sessions.items()},
        "saleReps": dict(sale_reps.most_common()),
        "repeatByPhone": {str(k): v for k, v in sorted(repeat.items())},
        "distinctPhones": len(phone_rows),
        "slipReuse": {str(k): v for k, v in sorted(collections.Counter(slip_rows.values()).items())},
    }

def _buckets(xs):
    if not xs:
        return {}
    edges = [0, 3000, 10000, 17000, 20000, 35000, 60000, 120000, 250000, 10**9]
    out = collections.Counter()
    for v in xs:
        for a, b in zip(edges, edges[1:]):
            if a <= v < b:
                out[f"{a}-{b}"] += 1
                break
    return dict(out)

def main():
    path = sys.argv[1]
    sheets = sys.argv[2:]
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    prof = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "source": path.split("/")[-1],
        "note": "สถิติล้วน ไม่มี PII — ใช้ปั้นข้อมูล synthetic ให้รูปทรงเหมือนของจริง",
        "sheets": [profile_sheet(wb[s], s) for s in sheets],
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(prof, f, ensure_ascii=False, indent=2)
    print("เขียน", OUT)
    for s in prof["sheets"]:
        print(f"  {s['sheet']}: {s['rows']} แถว · {len(s['courseColumns'])} คอลัมน์คอร์ส · เบอร์ไม่ซ้ำ {s['distinctPhones']}")

main()
