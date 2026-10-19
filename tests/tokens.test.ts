import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatCompactTokens,
  formatExactTokens,
  formatTokenQuotaPair,
  hasForbiddenWanUnit,
} from "../src/tokens.ts";

test("compact tokens use K/M/B with at most one decimal", () => {
  assert.equal(formatCompactTokens(0), "0");
  assert.equal(formatCompactTokens(999), "999");
  assert.equal(formatCompactTokens(1000), "1K");
  assert.equal(formatCompactTokens(418_912_345), "418.9M");
  assert.equal(formatCompactTokens(1_000_000_000), "1B");
  assert.equal(formatCompactTokens(1_500_000_000), "1.5B");
  assert.equal(formatExactTokens(418_912_345), "418,912,345");
});

test("formatTokenQuotaPair provides K/M/B compact display and exact integer without 万/亿", () => {
  const pair = formatTokenQuotaPair(418_900_000);
  assert.equal(pair.compact, "418.9M");
  assert.equal(pair.exact, "418,900,000");
  assert.equal(pair.rawInteger, 418_900_000);
  assert.equal(hasForbiddenWanUnit(pair.compact), false);
  assert.equal(hasForbiddenWanUnit(pair.exact), false);

  const invalid = formatTokenQuotaPair(null);
  assert.equal(invalid.compact, "—");
  assert.equal(invalid.rawInteger, null);
});

