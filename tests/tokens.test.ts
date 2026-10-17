import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCompactTokens, formatExactTokens } from "../src/tokens.ts";

test("compact tokens use K/M/B with at most one decimal", () => {
  assert.equal(formatCompactTokens(0), "0");
  assert.equal(formatCompactTokens(999), "999");
  assert.equal(formatCompactTokens(1000), "1K");
  assert.equal(formatCompactTokens(418_912_345), "418.9M");
  assert.equal(formatCompactTokens(1_000_000_000), "1B");
  assert.equal(formatCompactTokens(1_500_000_000), "1.5B");
  assert.equal(formatExactTokens(418_912_345), "418,912,345");
});
