import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

// Load the TypeScript extension through jiti and pull out the exported pure
// helpers. These functions carry no TUI/session state, so they are exercised
// directly here.
const jiti = createJiti(import.meta.url, { moduleCache: false });
const extensionPath = fileURLToPath(new URL("../extensions/prompt-timer/index.ts", import.meta.url));
const {
  formatDuration,
  formatDurationCoarse,
  cacheLevel,
  cacheCountdown,
  estimateCacheMissCost,
  formatEstimatedCost,
  truncatePrompt,
  buildDefaultPath,
  reconstructHistory,
  findLastAssistantUsage,
  stripControlChars,
  resolveWithinCwd,
  renderHistoryMarkdown,
  renderHistoryCsv,
  renderHistoryJson,
  rewarmForTurn,
  totalRewarmCost,
  formatRewarmBadge,
  TimerHistoryComponent,
} = await jiti.import(extensionPath);

const FIVE_MIN = 5 * 60_000;

test("formatDuration renders seconds, m:ss, and h:mm:ss", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(5_000), "5s");
  assert.equal(formatDuration(65_000), "1:05");
  assert.equal(formatDuration(3_661_000), "1:01:01");
});

test("cacheCountdown moves through dim, warning, and error bands", () => {
  const base = 1_700_000_000_000;
  const dim = cacheCountdown(base, base + 10_000);
  assert.equal(dim.level, "dim");

  const warning = cacheCountdown(base, base + 4 * 60_000 + 10_000);
  assert.equal(warning.level, "warning");
  assert.match(warning.text, /cache TTL expires in/);

  const error = cacheCountdown(base, base + 5 * 60_000 + 1_000);
  assert.equal(error.level, "error");
  assert.match(error.text, /cache TTL expired/);
  assert.match(error.text, /idle 1s/);
});

test("cacheCountdown reports expiry age with coarse, non-growing-precision duration", () => {
  const base = 1_700_000_000_000;
  const expiredFor58m = cacheCountdown(base, base + 5 * 60_000 + 58 * 60_000);
  assert.match(expiredFor58m.text, /idle 58m/);

  const expiredFor1h5m = cacheCountdown(base, base + 5 * 60_000 + 65 * 60_000);
  assert.match(expiredFor1h5m.text, /idle 1h 5m/);
});

test("cacheLevel matches the bands cacheCountdown uses", () => {
  assert.equal(cacheLevel(0), "dim");
  assert.equal(cacheLevel(4 * 60_000 - 1), "dim");
  assert.equal(cacheLevel(4 * 60_000), "warning");
  assert.equal(cacheLevel(5 * 60_000 - 1), "warning");
  assert.equal(cacheLevel(5 * 60_000), "error");
});

test("formatDurationCoarse drops seconds past a minute and minutes past an hour", () => {
  assert.equal(formatDurationCoarse(45_000), "45s");
  assert.equal(formatDurationCoarse(59_000), "59s");
  assert.equal(formatDurationCoarse(60_000), "1m");
  assert.equal(formatDurationCoarse(58 * 60_000 + 40_000), "58m");
  assert.equal(formatDurationCoarse(60 * 60_000), "1h");
  assert.equal(formatDurationCoarse(65 * 60_000), "1h 5m");
});

test("estimateCacheMissCost uses the cache-write rate when the provider charges one", () => {
  // Anthropic-style: cacheRead cheap, cacheWrite pricier than plain input.
  const rates = { input: 3, cacheRead: 0.3, cacheWrite: 3.75 }; // $/1M tokens
  const cost = estimateCacheMissCost(100_000, rates);
  assert.ok(cost !== null);
  // (3.75 - 0.3) * 100_000 / 1_000_000 = 0.345
  assert.ok(Math.abs(cost - 0.345) < 1e-9, `expected ~0.345, got ${cost}`);
});

test("estimateCacheMissCost falls back to the input rate when there is no cache-write rate", () => {
  // OpenAI/Gemini-style implicit caching: no separate write fee, a miss just
  // means those tokens become plain input tokens again.
  const rates = { input: 2, cacheRead: 0.5, cacheWrite: 0 };
  const cost = estimateCacheMissCost(200_000, rates);
  assert.ok(cost !== null);
  // (2 - 0.5) * 200_000 / 1_000_000 = 0.3
  assert.ok(Math.abs(cost - 0.3) < 1e-9, `expected ~0.3, got ${cost}`);
});

test("estimateCacheMissCost returns null when there is nothing to estimate", () => {
  assert.equal(estimateCacheMissCost(0, { input: 3, cacheRead: 0.3, cacheWrite: 3.75 }), null);
  assert.equal(estimateCacheMissCost(100_000, null), null);
  assert.equal(estimateCacheMissCost(100_000, { input: 0, cacheRead: 0, cacheWrite: 0 }), null);
  // cacheRead >= the miss rate (unusual, but should never report a negative cost)
  assert.equal(estimateCacheMissCost(100_000, { input: 1, cacheRead: 5, cacheWrite: 0 }), null);
});

test("formatEstimatedCost floors tiny amounts and rounds to cents otherwise", () => {
  assert.equal(formatEstimatedCost(0.004), "<$0.01");
  assert.equal(formatEstimatedCost(0.01), "$0.01");
  assert.equal(formatEstimatedCost(1.014), "$1.01");
});

test("findLastAssistantUsage returns the most recent assistant message's cache usage", () => {
  const entry = (role, usage) => ({ type: "message", message: { role, usage } });
  assert.equal(findLastAssistantUsage([]), null);
  assert.equal(findLastAssistantUsage([entry("user", undefined)]), null);

  const entries = [
    entry("user", undefined),
    entry("assistant", { cacheRead: 1_000, cacheWrite: 200 }),
    entry("user", undefined),
    entry("assistant", { cacheRead: 5_000, cacheWrite: 0 }),
  ];
  assert.deepEqual(findLastAssistantUsage(entries), { cacheRead: 5_000, cacheWrite: 0 });
});

test("truncatePrompt keeps the first line and bounds the length", () => {
  assert.equal(truncatePrompt("hello"), "hello");
  assert.equal(truncatePrompt("first line\nsecond line"), "first line");

  const long = "x".repeat(80);
  const out = truncatePrompt(long);
  assert.ok(out.length <= 55, "truncated output stays within the preview budget");
  assert.ok(out.endsWith("…"), "truncated output is marked with an ellipsis");
});

test("buildDefaultPath yields a cwd-relative .scratch path with an optional slug", () => {
  assert.match(buildDefaultPath(undefined), /^\.scratch\/timer-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/);
  assert.match(buildDefaultPath("My Session!"), /^\.scratch\/timer-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-my-session\.md$/);
});

test("buildDefaultPath picks the extension for the requested export format", () => {
  assert.match(buildDefaultPath(undefined, "markdown"), /\.md$/);
  assert.match(buildDefaultPath(undefined, "csv"), /\.csv$/);
  assert.match(buildDefaultPath(undefined, "json"), /\.json$/);
});

test("reconstructHistory derives turns, durations, and wait gaps from the transcript", () => {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const iso = (ms) => new Date(ms).toISOString();
  const message = (role, ms, text) => ({
    type: "message",
    timestamp: iso(ms),
    message: { role, content: [{ type: "text", text }] },
  });

  const entries = [
    message("user", base, "do a thing"),
    message("assistant", base + 15_000, "did the thing"),
    message("user", base + 15_000 + 20 * 60_000, "another thing"),
    message("assistant", base + 15_000 + 20 * 60_000 + 3_000, "done"),
  ];

  const turns = reconstructHistory(entries);
  assert.equal(turns.length, 2);

  assert.equal(turns[0].promptText, "do a thing");
  assert.equal(turns[0].durationMs, 15_000);
  assert.equal(turns[0].waitBeforeMs, 0);

  assert.equal(turns[1].promptText, "another thing");
  assert.equal(turns[1].durationMs, 3_000);
  assert.equal(turns[1].waitBeforeMs, 20 * 60_000);
});

test("reconstructHistory ignores non-message and empty entries", () => {
  assert.deepEqual(reconstructHistory([]), []);
  assert.deepEqual(
    reconstructHistory([{ type: "custom", customType: "whatever", data: {} }]),
    [],
  );
});

test("stripControlChars removes escape/control bytes", () => {
  assert.equal(stripControlChars("hello"), "hello");
  assert.equal(stripControlChars("a\x1b]0;evilb"), "a]0;evilb");
  assert.equal(stripControlChars("tab\tbell\x07nul\x00"), "tabbellnul");
});

test("renderHistoryMarkdown includes waiting rows and turn rows", () => {
  const meta = { date: new Date("2026-01-01T12:00:00.000Z"), sessionName: "my-session", cwd: "/repo" };
  const history = [
    { promptText: "first", durationMs: 5_000, waitBeforeMs: 0, at: Date.parse("2026-01-01T12:00:00.000Z") },
    { promptText: "second", durationMs: 3_000, waitBeforeMs: 60_000, at: Date.parse("2026-01-01T12:05:00.000Z") },
  ];
  const out = renderHistoryMarkdown(history, meta);
  assert.match(out, /# Timer History/);
  assert.match(out, /\*\*Session:\*\* my-session/);
  assert.match(out, /\*\*CWD:\*\* \/repo/);
  assert.match(out, /waiting/);
  assert.match(out, /first/);
  assert.match(out, /second/);
});

test("renderHistoryMarkdown appends the session rewarm total when present", () => {
  const meta = { date: new Date("2026-01-01T12:00:00.000Z"), cwd: "/repo" };
  const history = [
    { promptText: "first", durationMs: 5_000, waitBeforeMs: 0, at: Date.parse("2026-01-01T12:00:00.000Z") },
    {
      promptText: "rewarmed",
      durationMs: 3_000,
      waitBeforeMs: 6 * 60_000,
      at: Date.parse("2026-01-01T12:06:00.000Z"),
      rewarm: { tokens: 50_000, usd: 0.1875, metered: true, model: "some-model" },
    },
  ];
  const out = renderHistoryMarkdown(history, meta);
  assert.match(out, /rewarm \$0\.19/);
  assert.match(out, /\*\*Session rewarm total:\*\* \$0\.19/);

  // No rewarm turns → no total section at all.
  const plain = renderHistoryMarkdown([history[0]], meta);
  assert.ok(!plain.includes("Session rewarm total"));
});

test("renderHistoryCsv carries per-turn rewarm columns", () => {
  const history = [
    { promptText: "plain", durationMs: 1_500, waitBeforeMs: 0, at: Date.parse("2026-01-01T00:00:00.000Z") },
    {
      promptText: "rewarmed",
      durationMs: 2_000,
      waitBeforeMs: 6 * 60_000,
      at: Date.parse("2026-01-01T00:06:00.000Z"),
      rewarm: { tokens: 50_000, usd: 0.1875, metered: true, model: "some-model" },
    },
  ];
  const lines = renderHistoryCsv(history).trim().split("\n");
  assert.equal(lines[0], "timestamp,duration_ms,duration,wait_before_ms,rewarm_tokens,rewarm_usd,rewarm_metered,prompt");
  assert.match(lines[1], /^\d{2}:\d{2}:\d{2},1500,1s,0,,,,plain$/);
  assert.match(lines[2], /^\d{2}:\d{2}:\d{2},2000,2s,360000,50000,0\.1875,true,rewarmed$/);
});

test("renderHistoryJson includes per-turn rewarm and a top-level total", () => {
  const meta = { date: new Date("2026-01-01T00:00:00.000Z"), sessionName: "s", cwd: "/repo" };
  const history = [
    { promptText: "hi", durationMs: 2_000, waitBeforeMs: 0, at: Date.parse("2026-01-01T00:00:00.000Z") },
    {
      promptText: "again",
      durationMs: 1_000,
      waitBeforeMs: 6 * 60_000,
      at: Date.parse("2026-01-01T00:06:00.000Z"),
      rewarm: { tokens: 50_000, usd: 0.1875, metered: false },
    },
  ];
  const parsed = JSON.parse(renderHistoryJson(history, meta));
  assert.equal(parsed.turns[0].rewarm, null);
  assert.deepEqual(parsed.turns[1].rewarm, { tokens: 50_000, usd: 0.1875, metered: false, model: null });
  assert.deepEqual(parsed.rewarmTotal, { usd: 0.1875, metered: false });

  const noRewarm = JSON.parse(renderHistoryJson([history[0]], meta));
  assert.equal(noRewarm.rewarmTotal, null);
});

test("TimerHistoryComponent pins the rewarm total inside a fixed-height box", () => {
  // Stub theme/TUI: no ANSI codes, no rendering. The layout math (fixed
  // CONTENT_ROWS, bottom-pinned summary) is what is under test.
  const theme = { fg: (_kind, s) => s };
  const tui = { requestRender() {} };
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const mkHistory = (withRewarm) => {
    const turns = [{ promptText: "first", durationMs: 5_000, waitBeforeMs: 0, at: base }];
    if (withRewarm) {
      turns.push({
        promptText: "again",
        durationMs: 1_000,
        waitBeforeMs: 6 * 60_000,
        at: base + 6 * 60_000,
        rewarm: { tokens: 50_000, usd: 0.09, metered: true },
      });
    }
    return turns;
  };
  // Box top + tab strip + divider + 12 content rows + box bottom + hint.
  const EXPECTED_LINES = 17;

  const plain = new TimerHistoryComponent(mkHistory(false), null, "s", tui, theme, () => {}).render(72);
  assert.equal(plain.length, EXPECTED_LINES);
  assert.ok(!plain.some((l) => l.includes("Session rewarm total")));

  const withTotal = new TimerHistoryComponent(mkHistory(true), null, "s", tui, theme, () => {}).render(72);
  assert.equal(withTotal.length, EXPECTED_LINES, "summary rows must not grow the box");
  // Content rows are indices 3..14 (0 top, 1 tabs, 2 divider, 15 bottom, 16 hint).
  assert.match(withTotal[14], /Session rewarm total: \$0\.09/);
  assert.match(withTotal[13], /─+/);
  const rewarmRow = withTotal.find((l) => l.includes("again"));
  assert.ok(rewarmRow && rewarmRow.includes("rewarm $0.09"), `badge on the turn row, got: ${rewarmRow}`);
});

test("TimerHistoryComponent renders a rewarm badge without overflow at minimum width", () => {
  const theme = { fg: (_kind, s) => s };
  const tui = { requestRender() {} };
  const history = [
    {
      promptText: "a fairly long prompt preview that will definitely need truncating at this width",
      durationMs: 1_000,
      waitBeforeMs: 6 * 60_000,
      at: Date.parse("2026-01-01T00:00:00.000Z"),
      rewarm: { tokens: 1_000, usd: 0.004, metered: false },
    },
  ];
  const lines = new TimerHistoryComponent(history, null, "s", tui, theme, () => {}).render(54);
  const row = lines.find((l) => l.includes("rewarm ~"));
  assert.ok(row, "badge row present");
  assert.match(row, /rewarm ~<\$0\.01 \(est\.\)/);
  // truncateToWidth embeds ANSI resets when truncating; measure visible text.
  const visible = row.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(visible.length <= 54, `row fits the box, got visible length ${visible.length}`);
});

test("renderHistoryMarkdown handles empty history", () => {
  const meta = { date: new Date(), cwd: "/repo" };
  assert.match(renderHistoryMarkdown([], meta), /\(no history yet\)/);
});

test("renderHistoryCsv emits a header row and escapes commas/quotes/newlines", () => {
  const history = [
    { promptText: 'has, comma "and quotes"', durationMs: 1_500, waitBeforeMs: 0, at: Date.parse("2026-01-01T00:00:00.000Z") },
  ];
  const out = renderHistoryCsv(history);
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "timestamp,duration_ms,duration,wait_before_ms,rewarm_tokens,rewarm_usd,rewarm_metered,prompt");
  // Timestamp formatting is local-time (formatTimestamp), so only assert its
  // shape here; duration/wait/prompt fields are timezone-independent. A turn
  // with no rewarm leaves the three rewarm columns empty.
  assert.match(lines[1], /^\d{2}:\d{2}:\d{2},1500,1s,0,,,,"has, comma ""and quotes"""$/);
});

test("renderHistoryJson round-trips turn data as parseable JSON", () => {
  const meta = { date: new Date("2026-01-01T00:00:00.000Z"), sessionName: "s", cwd: "/repo" };
  const history = [
    { promptText: "hi", durationMs: 2_000, waitBeforeMs: 0, at: Date.parse("2026-01-01T00:00:00.000Z") },
  ];
  const parsed = JSON.parse(renderHistoryJson(history, meta));
  assert.equal(parsed.session, "s");
  assert.equal(parsed.cwd, "/repo");
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].prompt, "hi");
  assert.equal(parsed.turns[0].durationMs, 2_000);
});

test("rewarmForTurn only flags turns after a cache-TTL-expired gap", () => {
  const usage = { input: 100_000, cacheWrite: 80_000, cacheWriteCost: 0.3 };
  assert.equal(rewarmForTurn(null, FIVE_MIN + 1_000, null), undefined);
  assert.equal(rewarmForTurn(usage, FIVE_MIN - 1_000, null), undefined);
  assert.equal(rewarmForTurn(usage, 0, null), undefined);
});

test("rewarmForTurn reports the metered cache-write cost when the provider bills one", () => {
  const rewarm = rewarmForTurn(
    { input: 100_000, cacheWrite: 80_000, cacheWriteCost: 0.3, model: "some-model" },
    FIVE_MIN + 1_000,
    { input: 3, cacheRead: 0.3, cacheWrite: 3.75 },
  );
  assert.deepEqual(rewarm, { tokens: 80_000, usd: 0.3, metered: true, model: "some-model" });
});

test("rewarmForTurn estimates from token counts when no cache-write cost is reported", () => {
  const rates = { input: 3, cacheRead: 0.3, cacheWrite: 3.75 };
  // Explicit caching but no billed cost field: estimate from cacheWrite tokens.
  // (3.75 - 0.3) * 80_000 / 1_000_000 = 0.276
  const explicit = rewarmForTurn({ input: 100_000, cacheWrite: 80_000, cacheWriteCost: 0 }, FIVE_MIN, rates);
  assert.ok(explicit && explicit.metered === false);
  assert.equal(explicit.tokens, 80_000);
  assert.ok(Math.abs(explicit.usd - 0.276) < 1e-9, `expected ~0.276, got ${explicit.usd}`);

  // Implicit caching (cacheWrite 0): the rewarmed prefix is indistinguishable
  // inside plain input, so estimate from input tokens.
  const implicitRates = { input: 2, cacheRead: 0.5, cacheWrite: 0 };
  // (2 - 0.5) * 100_000 / 1_000_000 = 0.15
  const implicit = rewarmForTurn({ input: 100_000, cacheWrite: 0, cacheWriteCost: 0 }, FIVE_MIN, implicitRates);
  assert.ok(implicit && implicit.metered === false);
  assert.equal(implicit.tokens, 100_000);
  assert.ok(Math.abs(implicit.usd - 0.15) < 1e-9, `expected ~0.15, got ${implicit.usd}`);

  // No pricing at all: nothing to report rather than a misleading $0.00.
  assert.equal(rewarmForTurn({ input: 100_000, cacheWrite: 0, cacheWriteCost: 0 }, FIVE_MIN, null), undefined);
});

test("totalRewarmCost sums turns and marks a mixed total unmetered", () => {
  assert.equal(totalRewarmCost([]), null);
  assert.equal(totalRewarmCost([{ promptText: "a", durationMs: 1, waitBeforeMs: 0, at: 0 }]), null);

  const metered = { promptText: "a", durationMs: 1, waitBeforeMs: 0, at: 0, rewarm: { tokens: 1, usd: 0.1, metered: true } };
  const estimated = { promptText: "b", durationMs: 1, waitBeforeMs: 0, at: 0, rewarm: { tokens: 1, usd: 0.2, metered: false } };
  assert.deepEqual(totalRewarmCost([metered]), { usd: 0.1, metered: true });
  const mixed = totalRewarmCost([metered, estimated]);
  assert.ok(mixed && mixed.metered === false);
  assert.ok(Math.abs(mixed.usd - 0.3) < 1e-9, `expected ~0.3, got ${mixed.usd}`);
});

test("formatRewarmBadge marks estimates and leaves metered costs plain", () => {
  assert.equal(formatRewarmBadge({ tokens: 1, usd: 0.09, metered: true }), "rewarm $0.09");
  assert.equal(formatRewarmBadge({ tokens: 1, usd: 0.09, metered: false }), "rewarm ~$0.09 (est.)");
});

test("reconstructHistory attaches rewarm only to turns after a TTL-expired gap", () => {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const iso = (ms) => new Date(ms).toISOString();
  const user = (ms, text) => ({ type: "message", timestamp: iso(ms), message: { role: "user", content: [{ type: "text", text }] } });
  const assistant = (ms, usage) => ({
    type: "message",
    timestamp: iso(ms),
    message: { role: "assistant", model: "some-model", content: [{ type: "text", text: "done" }], usage },
  });

  const entries = [
    user(base, "cold start"),
    // Cold start writes the whole cache but is never a rewarm (no gap).
    assistant(base + 10_000, { input: 100_000, cacheWrite: 100_000, cost: { cacheWrite: 0.375 } }),
    user(base + 10_000 + 6 * 60_000, "after the TTL"),
    assistant(base + 10_000 + 6 * 60_000 + 5_000, { input: 5_000, cacheWrite: 50_000, cost: { cacheWrite: 0.1875 } }),
  ];

  const turns = reconstructHistory(entries);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].rewarm, undefined);
  assert.deepEqual(turns[1].rewarm, { tokens: 50_000, usd: 0.1875, metered: true, model: "some-model" });

  // With no billed cache-write cost, reconstruction estimates from the rates
  // passed by the caller (current model rates).
  const noCostEntries = [
    user(base, "cold start"),
    assistant(base + 10_000, { input: 100_000, cacheWrite: 100_000 }),
    user(base + 10_000 + 6 * 60_000, "after the TTL"),
    assistant(base + 10_000 + 6 * 60_000 + 5_000, { input: 5_000, cacheWrite: 50_000 }),
  ];
  const rates = { input: 3, cacheRead: 0.3, cacheWrite: 3.75 };
  const estimated = reconstructHistory(noCostEntries, rates);
  assert.ok(estimated[1].rewarm && estimated[1].rewarm.metered === false);
  // (3.75 - 0.3) * 50_000 / 1_000_000 = 0.1725
  assert.ok(Math.abs(estimated[1].rewarm.usd - 0.1725) < 1e-9, `expected ~0.1725, got ${estimated[1].rewarm.usd}`);
});

test("resolveWithinCwd confines custom paths to cwd", () => {
  const cwd = "/home/user/project";
  // valid relative paths resolve to an absolute inside cwd
  assert.equal(resolveWithinCwd(cwd, ".scratch/timer.md"), "/home/user/project/.scratch/timer.md");
  assert.equal(resolveWithinCwd(cwd, "notes/a.md"), "/home/user/project/notes/a.md");
  // rejected: absolute, traversal escape, empty, and cwd itself
  assert.equal(resolveWithinCwd(cwd, "/etc/passwd"), null);
  assert.equal(resolveWithinCwd(cwd, "../outside.md"), null);
  assert.equal(resolveWithinCwd(cwd, "../../etc/passwd"), null);
  assert.equal(resolveWithinCwd(cwd, ""), null);
  assert.equal(resolveWithinCwd(cwd, "."), null);
});
