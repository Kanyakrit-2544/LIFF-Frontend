import crypto from "node:crypto";
import fs from "node:fs";

/**
 * แลก service account key เป็น access token (JWT bearer flow)
 * เขียนเองเพราะต้องการแค่ฟังก์ชันเดียว ไม่คุ้มที่จะเพิ่ม googleapis ทั้งก้อน
 */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function loadServiceAccount(pathOrJson: string): ServiceAccount {
  const raw = pathOrJson.trim().startsWith("{") ? pathOrJson : fs.readFileSync(pathOrJson, "utf8");
  const sa = JSON.parse(raw) as ServiceAccount;
  if (!sa.client_email || !sa.private_key) throw new Error("service account JSON ไม่ครบ (ต้องมี client_email และ private_key)");
  return sa;
}

export async function getAccessToken(sa: ServiceAccount, scope = "https://www.googleapis.com/auth/spreadsheets"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(
    JSON.stringify({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })
  );
  const signature = b64(crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claim}`), sa.private_key));
  const assertion = `${header}.${claim}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`ขอ access token ไม่สำเร็จ: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export function sheetsApi(token: string, sheetId: string) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Sheets API ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };
  return {
    meta: () => call(""),
    batchUpdate: (requests: unknown[]) => call(":batchUpdate", { method: "POST", body: JSON.stringify({ requests }) }),
    getValues: (range: string) => call(`/values/${encodeURIComponent(range)}`),
    updateValues: (range: string, values: unknown[][]) =>
      call(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values }) }),
    appendValues: (range: string, values: unknown[][]) =>
      call(`/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: "POST", body: JSON.stringify({ values }),
      }),
    batchUpdateValues: (data: { range: string; values: unknown[][] }[]) =>
      call("/values:batchUpdate", { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data }) }),
  };
}
