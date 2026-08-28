/** payload ที่ Meta ส่งมาตอนมีคนกรอกฟอร์มโฆษณา — มีแต่ id ไม่มีข้อมูลลูกค้า (D31) */
export interface MetaWebhookBody {
  object?: string;
  entry?: MetaEntry[];
}

export interface MetaEntry {
  id?: string;
  time?: number;
  changes?: MetaChange[];
}

export interface MetaChange {
  field?: string;
  value?: {
    leadgen_id?: string;
    page_id?: string;
    form_id?: string;
    ad_id?: string;
    adgroup_id?: string;
    created_time?: number;
  };
}

/** สิ่งที่เราเก็บลง inbound_events.raw — id ล้วน ตรวจได้ว่าไม่มี PII */
export interface LeadgenNotification {
  leadgenId: string;
  pageId: string | null;
  formId: string | null;
  adId: string | null;
  adgroupId: string | null;
  createdTime: string | null;
}

/** โครงที่ Graph API คืนมาเมื่อดึงรายละเอียด lead */
export interface GraphLead {
  id?: string;
  created_time?: string;
  ad_id?: string;
  form_id?: string;
  field_data?: { name?: string; values?: string[] }[];
}

/**
 * แกะ notification ออกจาก webhook body
 * ข้าม change ที่ field ไม่ใช่ leadgen (Meta ส่ง field อื่นมาในช่องทางเดียวกัน)
 */
export function extractLeadgenNotifications(body: MetaWebhookBody): LeadgenNotification[] {
  const out: LeadgenNotification[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen") continue;
      const v = change.value ?? {};
      if (!v.leadgen_id) continue;
      out.push({
        leadgenId: String(v.leadgen_id),
        pageId: v.page_id ? String(v.page_id) : entry.id ? String(entry.id) : null,
        formId: v.form_id ? String(v.form_id) : null,
        adId: v.ad_id ? String(v.ad_id) : null,
        adgroupId: v.adgroup_id ? String(v.adgroup_id) : null,
        createdTime: v.created_time ? new Date(v.created_time * 1000).toISOString() : null,
      });
    }
  }
  return out;
}
