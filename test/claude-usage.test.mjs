import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClaudeUsage } from "../agents/claude.mjs";

test("normalizeClaudeUsage maps context and plan windows", () => {
  assert.deepEqual(
    normalizeClaudeUsage(
      { percentage: 49.6 },
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 40, resets_at: "2026-09-13T10:00:00Z" },
          seven_day: { utilization: 30.2, resets_at: "2026-09-20T10:00:00Z" },
        },
      },
    ),
    {
      context: { utilization: 49.6 },
      fiveHour: { utilization: 40, resetsAt: "2026-09-13T10:00:00Z" },
      sevenDay: { utilization: 30.2, resetsAt: "2026-09-20T10:00:00Z" },
    },
  );
});

test("normalizeClaudeUsage tolerates unavailable plan limits", () => {
  assert.deepEqual(
    normalizeClaudeUsage(
      { percentage: 12 },
      {
        rate_limits_available: false,
        rate_limits: { five_hour: { utilization: 99 } },
      },
    ),
    { context: { utilization: 12 }, fiveHour: null, sevenDay: null },
  );
});
