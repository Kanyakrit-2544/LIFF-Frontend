import { describe, it, expect } from "vitest";
import { verifyMetaSignature } from "../src/security/metaSignature";
import { extractLeadgenNotifications } from "../src/leads/types";
import { mapLead } from "../src/leads/mapLead";
import { pickMapping, buildAttribution, type LeadFormMappingDoc } from "../src/leads/attribution";
import crypto from "node:crypto";

const SECRET = "app-secret-for-test";
const sign = (body: string, secret = SECRET) =>
  "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");

describe("verifyMetaSignature", () => {
  const body = '{"object":"page","entry":[]}';
  it("ลายเซ็นถูกต้องผ่าน", () => {
    expect(verifyMetaSignature(body, sign(body), SECRET)).toBe(true);
  });
  it("⭐ ผิดไป 1 ตัวอักษรไม่ผ่าน", () => {
    const s = sign(body);
    expect(verifyMetaSignature(body, s.slice(0, -1) + (s.endsWith("a") ? "b" : "a"), SECRET)).toBe(false);
  });
  it("ไม่มี header / secret ว่าง / เซ็นด้วย secret อื่น = ไม่ผ่าน", () => {
    expect(verifyMetaSignature(body, null, SECRET)).toBe(false);
    expect(verifyMetaSignature(body, sign(body), "")).toBe(false);
    expect(verifyMetaSignature(body, sign(body, "another"), SECRET)).toBe(false);
  });
  it("ความยาวต่างกันต้องไม่ throw", () => {
    expect(verifyMetaSignature(body, "sha256=สั้น", SECRET)).toBe(false);
  });
});

describe("extractLeadgenNotifications", () => {
  const body = {
    object: "page",
    entry: [
      { id: "PAGE1", time: 1787900000, changes: [
        { field: "leadgen", value: { leadgen_id: "L1", page_id: "PAGE1", form_id: "F1", ad_id: "AD1", created_time: 1787900000 } },
        { field: "messages", value: { leadgen_id: "ไม่ควรถูกหยิบ" } },
      ]},
      { id: "PAGE1", changes: [{ field: "leadgen", value: { leadgen_id: "L2" } }] },
    ],
  };
  it("หยิบเฉพาะ field leadgen และได้ครบทุก entry", () => {
    const r = extractLeadgenNotifications(body);
    expect(r.map((x) => x.leadgenId)).toEqual(["L1", "L2"]);
  });
  it("ใช้ entry.id เป็น pageId เมื่อ value ไม่มี page_id", () => {
    expect(extractLeadgenNotifications(body)[1]!.pageId).toBe("PAGE1");
  });
  it("⭐ สิ่งที่เก็บลง inbound_events ต้องไม่มี PII เลย", () => {
    const json = JSON.stringify(extractLeadgenNotifications(body));
    expect(json).not.toMatch(/[ก-๙]/);
    expect(json).not.toMatch(/@/);
    expect(json).not.toMatch(/0[689]\d{8}/);
    expect(Object.keys(extractLeadgenNotifications(body)[0]!).sort()).toEqual(
      ["adId", "adgroupId", "createdTime", "formId", "leadgenId", "pageId"]
    );
  });
  it("body ว่าง/ผิดรูป ไม่ throw", () => {
    expect(extractLeadgenNotifications({})).toEqual([]);
    expect(extractLeadgenNotifications({ entry: [{ changes: [{ field: "leadgen" }] }] })).toEqual([]);
  });
});

describe("mapLead", () => {
  const lead = (fields: [string, string][]) => ({ field_data: fields.map(([name, v]) => ({ name, values: [v] })) });

  it("รวม first_name + last_name เมื่อไม่มี full_name", () => {
    expect(mapLead(lead([["first_name", "สมชาย"], ["last_name", "ใจดี"]])).displayName).toBe("สมชาย ใจดี");
  });
  it("normalize เบอร์ได้ทุกรูปแบบที่ Meta ส่งมา", () => {
    for (const raw of ["0812345678", "+66812345678", "081-234-5678"]) {
      expect(mapLead(lead([["phone_number", raw]])).phone, raw).toBe("+66812345678");
    }
  });
  it("เบอร์/อีเมลที่ใช้ไม่ได้ = null ไม่เก็บค่าดิบ", () => {
    const m = mapLead(lead([["phone_number", "123"], ["email", "ไม่ใช่อีเมล"]]));
    expect(m.phone).toBeNull();
    expect(m.email).toBeNull();
  });
  it("อีเมลตัวพิมพ์ใหญ่ถูก normalize", () => {
    expect(mapLead(lead([["email", "Somchai@GMAIL.com"]])).email).toBe("somchai@gmail.com");
  });

  it("⭐ ฟอร์มไม่มีคำถาม consent → consent เป็น null และ needsConsent เป็น true (D33)", () => {
    const m = mapLead(lead([["full_name", "สมชาย ใจดี"], ["phone_number", "0812345678"]]));
    expect(m.consent).toBeNull();
    expect(m.needsConsent).toBe(true);
  });
  it("⭐ มีคำถาม consent แต่ตอบปฏิเสธ → ยังถือว่าไม่ยินยอม", () => {
    const m = mapLead(lead([["pdpa_consent", "no"]]), { dataProcessing: "pdpa_consent" });
    expect(m.consent).toEqual({ dataProcessing: false, marketing: false });
    expect(m.needsConsent).toBe(true);
  });
  it("ตอบยินยอมจริงจึงจะได้ consent", () => {
    const m = mapLead(lead([["pdpa_consent", "ยินยอม"], ["news", "yes"]]), { dataProcessing: "pdpa_consent", marketing: "news" });
    expect(m.consent).toEqual({ dataProcessing: true, marketing: true });
    expect(m.needsConsent).toBe(false);
  });
  it("⭐ ฟิลด์ที่ไม่รู้จักถูกทิ้ง เหลือแค่ชื่อฟิลด์ให้คนตรวจ (D35)", () => {
    const m = mapLead(lead([["full_name", "สมชาย ใจดี"], ["รายได้ต่อเดือน", "50000"], ["โรคประจำตัว", "ไม่มี"]]));
    expect(m.ignoredFields).toEqual(["รายได้ต่อเดือน", "โรคประจำตัว"]);
    expect(JSON.stringify(m)).not.toContain("50000");
  });
});

describe("attribution", () => {
  const now = new Date("2026-08-28T00:00:00Z");
  const m = (matchOn: "adId" | "formId" | "pageId", matchValue: string, courseCode: string | null): LeadFormMappingDoc => ({
    _id: `lfm_${matchValue}`, matchOn, matchValue, courseCode, campaignName: `แคมเปญ ${matchValue}`,
    adOrOrganic: "ad", hashtags: [], note: null, createdAt: now, updatedAt: now,
  });
  const notif = { leadgenId: "L1", pageId: "P1", formId: "F1", adId: "AD1", adgroupId: null, createdTime: null };

  it("⭐ adId ชนะ formId ชนะ pageId", () => {
    const all = [m("pageId", "P1", "COMMU"), m("formId", "F1", "PRESENT"), m("adId", "AD1", "INNER")];
    expect(pickMapping(notif, all)?.courseCode).toBe("INNER");
    expect(pickMapping(notif, all.slice(0, 2))?.courseCode).toBe("PRESENT");
    expect(pickMapping(notif, all.slice(0, 1))?.courseCode).toBe("COMMU");
  });
  it("⭐ ไม่มี mapping → attributionPending และ courseCode เป็น null ไม่เดา (D34)", () => {
    const a = buildAttribution(notif, null, now);
    expect(a.attributionPending).toBe(true);
    expect(a.courseCode).toBeNull();
    expect(a.adOrOrganic).toBe("unknown");
    expect(a.adId).toBe("AD1"); // ยังเก็บ id ดิบไว้ให้เติมทีหลังได้
  });
  it("มี mapping → ไม่ pending และได้คอร์ส/แคมเปญ", () => {
    const a = buildAttribution(notif, m("adId", "AD1", "INNER"), now);
    expect(a.attributionPending).toBe(false);
    expect(a.courseCode).toBe("INNER");
    expect(a.adOrOrganic).toBe("ad");
  });
});
