/** Compact token display for BGSSAI quota (REQ-COMPOSITOR-COMMON-019).
 * UI uses K/M/B with at most one decimal; APIs keep exact integers. Never use 万. */

export function formatExactTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.trunc(value).toLocaleString("en-US");
}

function oneDecimal(scaled: number): string {
  const rounded = Math.round(scaled * 10) / 10;
  if (Number.isInteger(rounded) || Math.abs(rounded - Math.round(rounded)) < 1e-9) {
    return String(Math.round(rounded));
  }
  return rounded.toFixed(1);
}

export function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const n = Math.trunc(value);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${abs}`;

  let divisor = 1_000;
  let suffix = "K";
  if (abs >= 1_000_000_000) {
    divisor = 1_000_000_000;
    suffix = "B";
  } else if (abs >= 1_000_000) {
    divisor = 1_000_000;
    suffix = "M";
  }

  let scaled = abs / divisor;
  let rounded = Math.round(scaled * 10) / 10;
  if (rounded >= 1000) {
    if (suffix === "K") {
      divisor = 1_000_000;
      suffix = "M";
    } else if (suffix === "M") {
      divisor = 1_000_000_000;
      suffix = "B";
    }
    scaled = abs / divisor;
    rounded = Math.round(scaled * 10) / 10;
  }
  return `${sign}${oneDecimal(rounded)}${suffix}`;
}

export function tokenDisplayTitle(value: number): string {
  return formatExactTokens(value);
}

export type TokenQuotaPair = {
  compact: string;
  exact: string;
  rawInteger: number | null;
};

/**
 * Formats a token quota into both compact UI display (K/M/B, max 1 decimal, never 万)
 * and exact integer representation for tooltips, logs, and API receipts.
 */
export function formatTokenQuotaPair(value: number | null | undefined): TokenQuotaPair {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { compact: "—", exact: "—", rawInteger: null };
  }
  const intVal = Math.trunc(value);
  return {
    compact: formatCompactTokens(intVal),
    exact: formatExactTokens(intVal),
    rawInteger: intVal,
  };
}

export function hasForbiddenWanUnit(formatted: string): boolean {
  return formatted.includes("万") || formatted.includes("亿");
}

