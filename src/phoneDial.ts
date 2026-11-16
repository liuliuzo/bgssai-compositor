export interface DialCodeEntry {
  iso: string;
  dial: string;
  name: string;
  en: string;
}

export const DEFAULT_DIAL_CODE = "+86";

export const DIAL_CODES: readonly DialCodeEntry[] = [
  { iso: "CN", dial: "+86", name: "中国大陆", en: "China" },
  { iso: "HK", dial: "+852", name: "中国香港", en: "Hong Kong" },
  { iso: "MO", dial: "+853", name: "中国澳门", en: "Macao" },
  { iso: "TW", dial: "+886", name: "中国台湾", en: "Taiwan" },
  { iso: "SG", dial: "+65", name: "新加坡", en: "Singapore" },
  { iso: "JP", dial: "+81", name: "日本", en: "Japan" },
  { iso: "KR", dial: "+82", name: "韩国", en: "South Korea" },
  { iso: "US", dial: "+1", name: "美国 / 加拿大", en: "United States / Canada" },
  { iso: "GB", dial: "+44", name: "英国", en: "United Kingdom" },
  { iso: "DE", dial: "+49", name: "德国", en: "Germany" },
  { iso: "FR", dial: "+33", name: "法国", en: "France" },
  { iso: "AU", dial: "+61", name: "澳大利亚", en: "Australia" },
  { iso: "MY", dial: "+60", name: "马来西亚", en: "Malaysia" },
  { iso: "TH", dial: "+66", name: "泰国", en: "Thailand" },
  { iso: "VN", dial: "+84", name: "越南", en: "Vietnam" },
  { iso: "AE", dial: "+971", name: "阿联酋", en: "UAE" },
  { iso: "SA", dial: "+966", name: "沙特阿拉伯", en: "Saudi Arabia" },
  { iso: "IN", dial: "+91", name: "印度", en: "India" },
  { iso: "ID", dial: "+62", name: "印度尼西亚", en: "Indonesia" },
  { iso: "PH", dial: "+63", name: "菲律宾", en: "Philippines" },
  { iso: "NL", dial: "+31", name: "荷兰", en: "Netherlands" },
  { iso: "CH", dial: "+41", name: "瑞士", en: "Switzerland" },
  { iso: "IT", dial: "+39", name: "意大利", en: "Italy" },
  { iso: "ES", dial: "+34", name: "西班牙", en: "Spain" },
];

export function digitsOnly(value: string): string {
  return String(value ?? "").replace(/\D/g, "");
}

export function normalizeDialCode(dialCode?: string): string {
  const raw = String(dialCode ?? "").trim();
  if (!raw) return DEFAULT_DIAL_CODE;
  const cleaned = raw.startsWith("00") ? raw.slice(2) : raw;
  const digits = digitsOnly(cleaned).replace(/^0+/, "");
  if (!digits) return DEFAULT_DIAL_CODE;
  return `+${digits.slice(0, 4)}`;
}

export function composeE164Phone(
  dialCode: string,
  nationalNumber: string,
): string {
  const rawNational = String(nationalNumber ?? "").trim();
  if (!rawNational) return "";
  if (rawNational.startsWith("+")) {
    const digits = digitsOnly(rawNational);
    return digits ? `+${digits}` : "";
  }
  const dial = normalizeDialCode(dialCode);
  let digits = digitsOnly(rawNational);
  if (!digits) return "";
  if (dial === "+86" && digits.length === 13 && digits.startsWith("861")) {
    digits = digits.slice(2);
  }
  return `${dial}${digits}`;
}

export function validatePhoneParts(
  dialCode: string,
  nationalNumber: string,
): { ok: boolean; e164: string; error?: string } {
  const e164 = composeE164Phone(dialCode, nationalNumber);
  if (!e164) {
    return { ok: false, e164: "", error: "请输入手机号" };
  }
  if (e164.startsWith("+86")) {
    if (!/^\+861[3-9]\d{9}$/.test(e164)) {
      return {
        ok: false,
        e164,
        error: "中国大陆手机号格式错误（需 11 位 1 开头号码）",
      };
    }
    return { ok: true, e164 };
  }
  if (!/^\+[1-9]\d{4,14}$/.test(e164)) {
    return {
      ok: false,
      e164,
      error: "国际手机号格式错误（需符合 E.164，5-15 位数字）",
    };
  }
  return { ok: true, e164 };
}

export function nationalMaxLength(dialCode: string): number {
  return normalizeDialCode(dialCode) === "+86" ? 11 : 15;
}

export function nationalPlaceholder(dialCode: string): string {
  return normalizeDialCode(dialCode) === "+86"
    ? "11 位手机号"
    : "不含区号的手机号";
}

export function findDialEntry(dialCode: string): DialCodeEntry {
  const normalized = normalizeDialCode(dialCode);
  return (
    DIAL_CODES.find((entry) => entry.dial === normalized) ?? {
      iso: "INTL",
      dial: normalized,
      name: "国际区号",
      en: "International",
    }
  );
}

export function toDialItems(query?: string): DialCodeEntry[] {
  const q = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!q) return [...DIAL_CODES];
  const bare = q.replace(/^\+/, "");
  return DIAL_CODES.filter(
    (entry) =>
      entry.dial.toLowerCase().includes(q) ||
      entry.dial.slice(1).includes(bare) ||
      entry.iso.toLowerCase().includes(q) ||
      entry.name.toLowerCase().includes(q) ||
      entry.en.toLowerCase().includes(q),
  );
}
