import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCodexUsage, resetFromMessage } from "../agents/codex.mjs";

test("normalizeCodexUsage maps rollout token_count", () => {
  assert.deepEqual(
    normalizeCodexUsage({
      info: {
        last_token_usage: { total_tokens: 129200 },
        model_context_window: 258400,
      },
      rate_limits: {
        primary: {
          used_percent: 40,
          window_minutes: 300,
          resets_at: 1787931080,
        },
        secondary: {
          used_percent: 30,
          window_minutes: 10080,
          resets_at: 1788452818,
        },
      },
    }),
    {
      context: { utilization: 50 },
      fiveHour: { utilization: 40, resetsAt: "2026-08-28T15:31:20.000Z" },
      sevenDay: { utilization: 30, resetsAt: "2026-09-03T16:26:58.000Z" },
    },
  );
});

test("normalizeCodexUsage accepts App Server camelCase fields", () => {
  assert.deepEqual(
    normalizeCodexUsage({
      tokenUsage: { last: { totalTokens: 25 }, modelContextWindow: 100 },
      rateLimits: {
        primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      },
    }),
    {
      context: { utilization: 25 },
      fiveHour: { utilization: 5, resetsAt: null },
      sevenDay: null,
    },
  );
});

test("resetFromMessage recovers the reset time from a usage-limit message", () => {
  // When the limit is hit, structured rate_limits becomes null, so the reset time only survives in the message text.
  const msg =
    "You've hit your usage limit. Upgrade to Pro or try again at 5:59 PM.";
  const iso = resetFromMessage(msg);
  const d = new Date(iso);
  assert.equal(d.getHours(), 17); // 5:59 PM local time
  assert.equal(d.getMinutes(), 59);
  assert.ok(d.getTime() > Date.now() - 60_000); // must not resolve to a time in the past

  // If an absolute date-time is present, adopt it as-is.
  assert.equal(
    resetFromMessage("try again at 2026-09-14T02:30:00Z."),
    "2026-09-14T02:30:00.000Z",
  );
  // If there is no wording indicating a reset, the result is null.
  assert.equal(resetFromMessage("some unrelated error"), null);
});
