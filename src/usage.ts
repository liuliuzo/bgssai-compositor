import { formatCompactTokens, formatExactTokens } from "./tokens";

export type ModelPrice = {
  id: string; hub: string; billing_multiplier?: number | null; billing_unit?: string | null;
  price_version?: number | string | null; currency?: string | null; pricing_status?: string | null;
  input_fen_per_million?: number | null; output_fen_per_million?: number | null;
};
export type UsageReceipt = ModelPrice & {
  request_id: string; model: string; raw_tokens?: number | null; billed_tokens?: number | null;
  debit_fen?: number | null; billing_status: string; reconciled: boolean;
};
export function priceLabel(model: ModelPrice) {
  const multiplier = typeof model.billing_multiplier === "number" && model.billing_multiplier > 0
    ? `${model.billing_multiplier}×` : "倍率待配置";
  return `${model.id} · ${multiplier} · ${model.billing_unit ?? "单位未知"} · 价格版本 ${model.price_version ?? "未知"} · ${model.currency ?? "币种未知"}`;
}
export function usageLabel(value: UsageReceipt) {
  const hasQuota = Number.isSafeInteger(value.billed_tokens) && value.billed_tokens! >= 0;
  const quota = hasQuota ? formatCompactTokens(value.billed_tokens!) : "待确认";
  const exact = hasQuota ? formatExactTokens(value.billed_tokens!) : "";
  const cash = typeof value.debit_fen === "number" && value.currency ? `${value.debit_fen / 100} ${value.currency}` : "待确认";
  const raw = Number.isSafeInteger(value.raw_tokens) && value.raw_tokens! >= 0
    ? formatCompactTokens(value.raw_tokens!)
    : "待确认";
  return `原始 ${raw} token · 实扣 ${quota} ${value.billing_unit ?? "token"}${exact ? `（精确 ${exact}）` : ""} · 现金 ${cash} · ${value.billing_status}${value.reconciled ? "" : "（待对账）"}`;
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
