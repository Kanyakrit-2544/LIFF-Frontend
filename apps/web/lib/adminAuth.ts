export function staffEmailAllowlist(source = process.env.STAFF_EMAIL_ALLOWLIST ?? ""): Set<string> {
  return new Set(source.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
}

export function isAllowedStaffEmail(email: string | null | undefined, source?: string): boolean {
  return Boolean(email && staffEmailAllowlist(source).has(email.trim().toLowerCase()));
}
