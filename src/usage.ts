import { formatCompactTokens, formatExactTokens, formatTokenQuotaPair } from "./tokens";

export const TOKENHUB_CN_ID = "bgssai-tokenhub-cn";
export const TOKENHUB_GLOBAL_ID = "bgssai-tokenhub-global";
export const SUPPORTED_MULTIPLIERS = [0.5, 1.0, 1.5] as const;

export type ModelPrice = {
  id: string; hub: string; hub_provider?: string | null; billing_multiplier?: number | null; billing_unit?: string | null;
  price_version?: number | string | null; currency?: string | null; pricing_status?: string | null;
  input_fen_per_million?: number | null; output_fen_per_million?: number | null;
};
export type UsageReceipt = ModelPrice & {
  request_id: string; model: string; raw_tokens?: number | null; billed_tokens?: number | null;
  debit_fen?: number | null; billing_status: string; reconciled: boolean;
  task_kind?: "inpainting" | "layer_generation" | "text" | string | null;
};

export function resolveHubProviderId(hub?: string | null, hubProvider?: string | null): string {
  if (hubProvider && hubProvider.trim()) return hubProvider.trim();
  const normalized = (hub ?? "").trim().toLowerCase();
  if (normalized === "cn" || normalized === TOKENHUB_CN_ID || normalized.includes("cn")) {
    return TOKENHUB_CN_ID;
  }
  if (normalized === "global" || normalized === TOKENHUB_GLOBAL_ID) {
    return TOKENHUB_GLOBAL_ID;
  }
  return hub && hub.trim() ? hub.trim() : TOKENHUB_CN_ID;
}

export function isStandardMultiplier(multiplier?: number | null): boolean {
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier)) return false;
  return SUPPORTED_MULTIPLIERS.some((candidate) => Math.abs(candidate - multiplier) < 1e-6);
}

/**
 * Formats model multiplier explicitly in standard x notation (0.5x / 1.0x / 1.5x)
 * for regional bgssai-tokenhub-cn transparency.
 */
export function formatMultiplier(multiplier?: number | null): string {
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0) {
    return "倍率待配置";
  }
  if (Math.abs(multiplier - 0.5) < 1e-6) return "0.5x";
  if (Math.abs(multiplier - 1.0) < 1e-6) return "1.0x";
  if (Math.abs(multiplier - 1.5) < 1e-6) return "1.5x";
  return `${Number(multiplier.toFixed(2))}x`;
}

export function estimateBilledTokens(rawTokens?: number | null, multiplier?: number | null): number | null {
  if (typeof rawTokens !== "number" || !Number.isFinite(rawTokens) || rawTokens < 0) return null;
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0) return null;
  return Math.ceil(Math.trunc(rawTokens) * multiplier);
}

export function priceLabel(model: ModelPrice) {
  const hasMultiplier = typeof model.billing_multiplier === "number" && model.billing_multiplier > 0;
  const multiplier = hasMultiplier
    ? `${model.billing_multiplier}× (${formatMultiplier(model.billing_multiplier)})`
    : "倍率待配置";
  const provider = resolveHubProviderId(model.hub, model.hub_provider);
  return `${model.id} · ${provider} · ${multiplier} · ${model.billing_unit ?? "单位未知"} · 价格版本 ${model.price_version ?? "未知"} · ${model.currency ?? "币种未知"}`;
}
export function usageLabel(value: UsageReceipt) {
  const hasQuota = Number.isSafeInteger(value.billed_tokens) && value.billed_tokens! >= 0;
  const quota = hasQuota ? formatCompactTokens(value.billed_tokens!) : "待确认";
  const exact = hasQuota ? formatExactTokens(value.billed_tokens!) : "";
  const cash = typeof value.debit_fen === "number" && value.currency ? `${value.debit_fen / 100} ${value.currency}` : "待确认";
  const raw = Number.isSafeInteger(value.raw_tokens) && value.raw_tokens! >= 0
    ? formatCompactTokens(value.raw_tokens!)
    : "待确认";
  const multiplierText = typeof value.billing_multiplier === "number" && value.billing_multiplier > 0
    ? ` · 倍率 ${formatMultiplier(value.billing_multiplier)}`
    : "";
  return `原始 ${raw} 额度${multiplierText} · 实扣 ${quota} ${value.billing_unit ?? "额度"}${exact ? `（精确 ${exact}）` : ""} · 现金 ${cash} · ${value.billing_status}${value.reconciled ? "" : "（待对账）"}`;
}

export function aiTaskReceiptSummary(value: UsageReceipt): {
  provider: string;
  taskKindLabel: string;
  multiplierBadge: string;
  rawQuota: { compact: string; exact: string; rawInteger: number | null };
  billedQuota: { compact: string; exact: string; rawInteger: number | null };
  cashLabel: string;
  reconciliationLabel: string;
  summaryText: string;
} {
  const provider = resolveHubProviderId(value.hub, value.hub_provider);
  const taskKindLabel = value.task_kind === "inpainting"
    ? "AI 局部重绘/修补"
    : value.task_kind === "layer_generation"
      ? "AI 图层生成"
      : "AI 辅助任务";
  const multiplierBadge = formatMultiplier(value.billing_multiplier);
  const rawQuota = formatTokenQuotaPair(value.raw_tokens);
  const billedQuota = formatTokenQuotaPair(value.billed_tokens);
  const cashLabel = typeof value.debit_fen === "number" && value.currency
    ? `${(value.debit_fen / 100).toFixed(2)} ${value.currency}`
    : "待确认";
  const reconciliationLabel = value.reconciled ? "已对账" : "待对账";
  const summaryText = `[${provider}] ${taskKindLabel} · 模型 ${value.model} (${multiplierBadge}) · 原始 ${rawQuota.compact} · 实扣 ${billedQuota.compact} (精确 ${billedQuota.exact}) · 现金 ${cashLabel} · ${reconciliationLabel}`;
  return {
    provider,
    taskKindLabel,
    multiplierBadge,
    rawQuota,
    billedQuota,
    cashLabel,
    reconciliationLabel,
    summaryText,
  };
}

export function tokenSpanProps(value: number | null | undefined) {
  if (!Number.isSafeInteger(value) || value! < 0) {
    return { children: "待确认", title: undefined as string | undefined };
  }
  return {
    children: formatCompactTokens(value!),
    title: formatExactTokens(value!),
  };
}

