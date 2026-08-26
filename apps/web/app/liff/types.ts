export type Localized = { th: string; en?: string };
export type FieldOption = { value: string; label: Localized };

export type FormField = {
  id: string;
  type: string;
  label: Localized;
  placeholder?: Localized;
  help?: Localized;
  options?: FieldOption[];
  validate?: { required?: boolean; maxLength?: number };
  visibleIf?: { field: string; op: string; value?: unknown };
};

export type FormSection = { id: string; title: Localized; description?: Localized; fields: FormField[] };

export type FormSchema = {
  formId: string;
  version: string;
  title: Localized;
  submitLabel?: Localized;
  sections: FormSection[];
};

export type Bootstrap = {
  profile: {
    customerId: string;
    displayName: string | null;
    lineDisplayName: string | null;
    pictureUrl: string | null;
    customerStatus: string;
    memberSince: string | null;
    hasSubmittedBefore: boolean;
  };
  formSchema: FormSchema;
  prefill: Record<string, unknown>;
  consentRequired: boolean;
};

/** subset ของ LIFF SDK ที่หน้านี้ใช้ */
export interface LiffSdk {
  init(cfg: { liffId: string; withLoginOnExternalBrowser?: boolean }): Promise<void>;
  isLoggedIn(): boolean;
  login(cfg?: { redirectUri?: string }): void;
  getIDToken(): string | null;
  isInClient(): boolean;
  closeWindow(): void;
}
