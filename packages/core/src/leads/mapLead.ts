import { normalizeEmail, normalizeName, normalizePhone } from "../identity/normalize";
import type { GraphLead } from "./types";

/**
 * แปลงคำตอบในฟอร์ม Meta → ฟิลด์ลูกค้า
 *
 * D35: ฟอร์ม Meta ตั้งคำถามอะไรก็ได้ ถ้าเก็บดิบทั้งก้อนจะกลายเป็นถังขยะ PII
 * ที่ไม่มีใครรู้ว่ามีอะไรอยู่ข้างใน จึงรับเฉพาะฟิลด์ที่ตั้งใจ ที่เหลือทิ้ง
 *
 * D33: ห้ามสมมติว่ายินยอม — ไม่มีคำถาม consent = ไม่มี consent
 */

/** ชื่อฟิลด์มาตรฐานของ Meta (ผู้ใช้เปลี่ยนได้ จึงรับหลายแบบ) */
const FIELD_ALIASES: Record<string, string[]> = {
  fullName: ["full_name", "fullname", "name", "ชื่อ-นามสกุล", "ชื่อ"],
  firstName: ["first_name", "firstname"],
  lastName: ["last_name", "lastname"],
  phone: ["phone_number", "phone", "mobile", "เบอร์โทร", "เบอร์"],
  email: ["email", "email_address", "อีเมล"],
};

export interface LeadConsentField {
  /** ชื่อฟิลด์ในฟอร์มที่ถือเป็นคำถามยินยอม — ต้องระบุเอง ระบบไม่เดา */
  dataProcessing?: string | null;
  marketing?: string | null;
}

export interface MappedLead {
  displayName: string | null;
  phone: string | null;
  email: string | null;
  consent: { dataProcessing: boolean; marketing: boolean } | null;
  /** true = ฟอร์มไม่มีคำถาม consent → ห้ามส่งการตลาดจนกว่าจะได้ consent จริง */
  needsConsent: boolean;
  /** ชื่อฟิลด์ที่มีมาแต่เราไม่ได้เก็บ — ไว้ให้คนตรวจว่าพลาดอะไรไหม (ชื่อฟิลด์เท่านั้น ไม่ใช่ค่า) */
  ignoredFields: string[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "_");

function pick(lead: GraphLead, key: keyof typeof FIELD_ALIASES): string | null {
  const aliases = FIELD_ALIASES[key]!.map(norm);
  for (const f of lead.field_data ?? []) {
    if (!f.name) continue;
    if (aliases.includes(norm(f.name))) {
      const v = (f.values ?? []).find((x) => x != null && String(x).trim() !== "");
      if (v) return String(v).trim();
    }
  }
  return null;
}

function truthy(value: string | null): boolean {
  if (!value) return false;
  return ["true", "yes", "1", "ยินยอม", "ตกลง", "agree", "accept", "consent"].includes(value.trim().toLowerCase());
}

export function mapLead(lead: GraphLead, consentFields: LeadConsentField = {}): MappedLead {
  const full = pick(lead, "fullName");
  const first = pick(lead, "firstName");
  const last = pick(lead, "lastName");
  const joined = full ?? ([first, last].filter(Boolean).join(" ").trim() || null);

  const rawPhone = pick(lead, "phone");
  const rawEmail = pick(lead, "email");

  const byName = new Map((lead.field_data ?? []).filter((f) => f.name).map((f) => [norm(f.name!), f]));
  const readConsent = (fieldName: string | null | undefined): string | null => {
    if (!fieldName) return null;
    const f = byName.get(norm(fieldName));
    return f ? ((f.values ?? [])[0] ?? null) : null;
  };

  const dpField = consentFields.dataProcessing ?? null;
  const dpRaw = readConsent(dpField);
  // มีการตั้งชื่อฟิลด์ไว้ และฟอร์มตอบมาจริง จึงจะถือว่ามี consent
  const hasConsentField = Boolean(dpField) && dpRaw !== null;

  const known = new Set<string>();
  for (const key of Object.keys(FIELD_ALIASES)) {
    for (const a of FIELD_ALIASES[key]!) known.add(norm(a));
  }
  if (dpField) known.add(norm(dpField));
  if (consentFields.marketing) known.add(norm(consentFields.marketing));

  return {
    displayName: joined ? normalizeName(joined) : null,
    phone: normalizePhone(rawPhone),
    email: normalizeEmail(rawEmail),
    consent: hasConsentField
      ? { dataProcessing: truthy(dpRaw), marketing: truthy(readConsent(consentFields.marketing)) }
      : null,
    needsConsent: !hasConsentField || !truthy(dpRaw),
    ignoredFields: (lead.field_data ?? [])
      .map((f) => f.name)
      .filter((n): n is string => Boolean(n) && !known.has(norm(n!))),
  };
}
