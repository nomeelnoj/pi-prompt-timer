import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

// Load the TypeScript extension through jiti and pull out the exported pure
// helpers. These functions carry no TUI/session state, so they are exercised
// directly here.
const jiti = createJiti(import.meta.url, { moduleCache: false });
const extensionPath = fileURLToPath(new URL("../extensions/prompt-timer/index.ts", import.meta.url));
const {
  default: promptTimer,
  formatDuration,
  formatDurationCoarse,
  cacheLevel,
  cacheCountdown,
  parseRewarmDuration,
  parseRewarmConfig,
  shouldRewarmCache,
  rewarmProviderCache,
  estimateCacheMissCost,
  formatEstimatedCost,
  truncatePrompt,
  buildDefaultPath,
  reconstructHistory,
  findLastAssistantUsage,
  findLastAssistantTimestamp,
  stripControlChars,
  resolveWithinCwd,
  renderHistoryMarkdown,
  renderHistoryCsv,
  renderHistoryJson,
  rewarmForTurn,
  totalRewarmCost,
  formatRewarmBadge,
  dropInProgressTurn,
  writeHistoryFile,
  TimerHistoryComponent,
} = await jiti.import(extensionPath);

const FIVE_MIN = 5 * 60_000;

test("parseRewarmDuration accepts bounded minute/hour values and off", () => {
  assert.equal(parseRewarmDuration("1h"), 60 * 60_000);
  assert.equal(parseRewarmDuration("15m"), 15 * 60_000);
  assert.equal(parseRewarmDuration("off"), 0);
  assert.equal(parseRewarmDuration("0m"), null);
  assert.equal(parseRewarmDuration("25h"), null);
  assert.equal(parseRewarmDuration("1d"), null);
});

test("parseRewarmConfig defaults to one hour and validates its value", () => {
  assert.equal(parseRewarmConfig({}), 60 * 60_000);
  assert.equal(parseRewarmConfig({ rewarmDuration: "1h" }), 60 * 60_000);
  assert.equal(parseRewarmConfig({ rewarmDuration: "off" }), 0);
  assert.throws(() => parseRewarmConfig({ rewarmDuration: "soon" }), /rewarmDuration/);
  assert.throws(() => parseRewarmConfig([]), /JSON object/);
});

test("backend-only rewarm calls the provider without changing session entries", async () => {
  const timestamp = Date.parse("2026-01-01T00:00:00.000Z");
  const entries = [
    {
      type: "message",
      id: "user-entry",
      parentId: null,
      timestamp: new Date(timestamp).toISOString(),
      message: { role: "user", content: "existing context", timestamp },
    },
    {
      type: "message",
      id: "assistant-entry",
      parentId: "user-entry",
      timestamp: new Date(timestamp + 1_000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "prior response" }],
        api: "mock-api",
        provider: "mock-provider",
        model: "mock-model",
        usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: timestamp + 1_000,
      },
    },
  ];
  const originalEntries = structuredClone(entries);
  const tool = { name: "read", description: "Read files", parameters: {} };
  const calls = [];
  const ctx = {
    model: { provider: "mock-provider", id: "mock-model" },
    getSystemPrompt: () => "system prompt",
    sessionManager: { getBranch: () => entries, getLeafId: () => "assistant-entry" },
    modelRegistry: {
      complete: async (...args) => {
        calls.push(args);
        return { stopReason: "stop", usage: { cacheRead: 200, cacheWrite: 3 } };
      },
    },
  };

  const warmed = await rewarmProviderCache(ctx, [tool], new AbortController().signal);

  assert.deepEqual(warmed, { cacheTokens: 203 });
  assert.deepEqual(entries, originalEntries);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], ctx.model);
  assert.equal(calls[0][1].systemPrompt, "system prompt");
  assert.equal(calls[0][1].messages.length, 3);
  assert.equal(calls[0][1].messages.at(-1).role, "user");
  assert.equal(calls[0][1].messages.at(-1).content, ".");
  assert.deepEqual(calls[0][1].tools, [tool]);
  assert.equal(calls[0][2].maxTokens, 1);
});

test("scheduled cache rewarming calls the backend without sending a session message", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "prompt-timer-rewarm-"));
  const originalNow = Date.now;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let now = Date.parse("2026-01-01T00:03:46.000Z");
  const intervals = [];
  let backendCalls = 0;
  let sessionMessages = 0;
  const commands = new Map();
  const notifications = [];
  const statuses = new Map();
  let footerSet = false;
  const widgets = new Map();
  Date.now = () => now;
  globalThis.setInterval = (callback) => (intervals.push(callback), intervals.length);
  globalThis.clearInterval = () => {};

  const entries = [
    {
      type: "message",
      id: "user-entry",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "existing context", timestamp: now - 226_000 },
    },
    {
      type: "message",
      id: "assistant-entry",
      parentId: "user-entry",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "prior response" }],
        api: "mock-api",
        provider: "mock-provider",
        model: "mock-model",
        usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: now - 225_000,
      },
    },
  ];
  const ctx = {
    hasUI: true,
    cwd,
    model: { provider: "mock-provider", id: "mock-model", cost: { input: 1, cacheRead: 0, cacheWrite: 0 } },
    sessionManager: { getEntries: () => entries, getBranch: () => entries, getLeafId: () => "assistant-entry" },
    modelRegistry: {
      complete: async () => {
        backendCalls++;
        return { stopReason: "stop" };
      },
    },
    getSystemPrompt: () => "system prompt",
    ui: {
      theme: { fg: (_level, text) => text },
      setFooter: () => { footerSet = true; },
      setWidget: (key, lines, options) => (lines === undefined ? widgets.delete(key) : widgets.set(key, { lines, options })),
      setStatus: (key, text) => (text === undefined ? statuses.delete(key) : statuses.set(key, text)),
      setTitle() {},
      notify: (message) => notifications.push(message),
    },
  };
  const handlers = new Map();
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command.handler),
    registerShortcut() {},
    getSessionName: () => undefined,
    getActiveTools: () => [],
    getAllTools: () => [],
    sendMessage: () => { sessionMessages++; },
  };

  try {
    promptTimer(pi);
    await handlers.get("session_start")({}, ctx);
    assert.equal(intervals.length, 1);
    assert.equal(footerSet, false);
    assert.equal(statuses.size, 0);
    assert.equal(widgets.get("prompt-timer").options.placement, "belowEditor");
    const footer = { render: () => widgets.get("prompt-timer")?.lines ?? [] };
    intervals[0]();
    assert.match(footer.render(120).join(""), /rewarming/);
    assert.equal(backendCalls, 1);
    assert.equal(sessionMessages, 0);
    assert.equal(entries.length, 2);
    await new Promise((resolve) => setImmediate(resolve));
    now += 75_000;
    intervals[0]();
    const activeText = footer.render(120).join("");
    assert.match(activeText, /rewarm active/);
    assert.match(activeText, /⌛ 1:15/);
    assert.doesNotMatch(activeText, /cache TTL expired/);
    now += 60 * 60_000;
    intervals[0]();
    const endedText = footer.render(120).join("");
    assert.match(endedText, /rewarm window ended \(1h\)/);
    assert.match(endedText, /cache TTL expired/);
    await commands.get("timer")("rewarm status", ctx);
    assert.match(notifications.at(-1), /window ended after 1h/);
    await handlers.get("session_shutdown")({}, ctx);
    assert.equal(widgets.has("prompt-timer"), false);
  } finally {
    Date.now = originalNow;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shouldRewarmCache fires 75 seconds before expiry only while safely idle", () => {
  const lastProviderResponseAt = 10_000;
  const rewarmUntilMs = lastProviderResponseAt + 60 * 60_000;
  const base = {
    rewarmUntilMs,
    lastProviderResponseAt,
    lastAttemptAnchorAt: null,
    agentBusy: false,
    uiPromptActive: false,
    pendingInput: false,
  };

  assert.equal(shouldRewarmCache({ ...base, now: lastProviderResponseAt + FIVE_MIN - 75_001 }), false);
  assert.equal(shouldRewarmCache({ ...base, now: lastProviderResponseAt + FIVE_MIN - 75_000 }), true);
  assert.equal(shouldRewarmCache({ ...base, now: lastProviderResponseAt + FIVE_MIN - 1 }), true);
  assert.equal(shouldRewarmCache({ ...base, now: lastProviderResponseAt + FIVE_MIN }), false);
  assert.equal(shouldRewarmCache({ ...base, now: lastProviderResponseAt + FIVE_MIN }), false);
  assert.equal(shouldRewarmCache({ ...base, now: rewarmUntilMs }), false);
  assert.equal(shouldRewarmCache({ ...base, now: lastProviderResponseAt + FIVE_MIN - 1, agentBusy: true }), false);
  assert.equal(shouldRewarmCache({ ...base, now: lastProviderResponseAt + FIVE_MIN - 1, uiPromptActive: true }), false);
  assert.equal(shouldRewarmCache({ ...base, now: lastProviderResponseAt + FIVE_MIN - 1, pendingInput: true }), false);
  assert.equal(
    shouldRewarmCache({ ...base, now: lastProviderResponseAt + FIVE_MIN - 1, lastAttemptAnchorAt: lastProviderResponseAt }),
    false,
  );
});

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

test("findLastAssistantTimestamp includes hidden rewarm responses", () => {
  const entries = [
    { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } },
    { type: "message", timestamp: "2026-01-01T00:00:10.000Z", message: { role: "assistant" } },
    { type: "custom_message", customType: "prompt-timer-rewarm", display: false },
    { type: "message", timestamp: "2026-01-01T00:04:00.000Z", message: { role: "assistant" } },
  ];
  assert.equal(findLastAssistantTimestamp(entries), Date.parse("2026-01-01T00:04:00.000Z"));
  assert.equal(findLastAssistantTimestamp([]), null);
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

test("reconstructHistory excludes hidden rewarm responses from turn duration", () => {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const iso = (ms) => new Date(ms).toISOString();
  const entries = [
    { type: "message", timestamp: iso(base), message: { role: "user", content: [{ type: "text", text: "work" }] } },
    { type: "message", timestamp: iso(base + 10_000), message: { role: "assistant", content: "done", usage: { input: 20 } } },
    { type: "custom_message", customType: "prompt-timer-rewarm", display: false },
    { type: "message", timestamp: iso(base + 4 * 60_000), message: { role: "assistant", content: ".", usage: { input: 20 } } },
  ];
  const [turn] = reconstructHistory(entries);
  assert.equal(turn.durationMs, 10_000);
});

test("reconstructHistory uses rewarm responses to avoid false cache-miss badges", () => {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const iso = (ms) => new Date(ms).toISOString();
  const user = (ms, text) => ({ type: "message", timestamp: iso(ms), message: { role: "user", content: text } });
  const assistant = (ms) => ({ type: "message", timestamp: iso(ms), message: { role: "assistant", content: ".", usage: { input: 10 } } });
  const entries = [
    user(base, "first"),
    assistant(base + 10_000),
    { type: "custom_message", customType: "prompt-timer-rewarm", display: false },
    assistant(base + 3 * 60_000 + 46_000),
    user(base + 7 * 60_000, "second"),
    assistant(base + 7 * 60_000 + 1_000),
  ];

  const turns = reconstructHistory(entries, { input: 3, cacheRead: 0.3, cacheWrite: 3.75 });
  assert.equal(turns[0].durationMs, 10_000);
  assert.equal(turns[1].waitBeforeMs, 6 * 60_000 + 50_000);
  assert.equal(turns[1].rewarm, undefined);
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

test("truncatePrompt strips control characters so escape sequences cannot reach the overlay", () => {
  // An OSC 52 (clipboard-write) payload: the ESC/CSI bytes are removed and
  // only inert printable residue remains.
  const poisoned = "run this \x1b]52;c;AAAA\x07 please";
  const out = truncatePrompt(poisoned);
  assert.equal(out, "run this ]52;c;AAAA please");
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(out));
});

test("renderHistoryCsv neutralizes spreadsheet formula injection and quotes CR", () => {
  const rec = (promptText) => ({ promptText, durationMs: 1_000, waitBeforeMs: 0, at: 1_700_000_000_000 });
  // Formula metacharacters get an apostrophe prefix (the embedded quotes and
  // comma additionally force quoting, hence the leading '"').
  assert.ok(renderHistoryCsv([rec('=HYPERLINK("https://example.invalid","x")')]).includes(`"'=HYPERLINK`));
  assert.ok(renderHistoryCsv([rec("+1")]).includes("'+1"));
  assert.ok(renderHistoryCsv([rec("-2")]).includes("'-2"));
  assert.ok(renderHistoryCsv([rec("@x")]).includes("'@x"));
  assert.ok(renderHistoryCsv([rec("\t=cmd")]).includes("'\t=cmd"));
  // A bare CR is quoted so it cannot corrupt rows in spreadsheet parsers.
  assert.ok(renderHistoryCsv([rec("first line\r")]).includes('"first line\r"'));
});

test("reconstructHistory tolerates string content and non-numeric usage fields", () => {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const iso = (ms) => new Date(ms).toISOString();
  // String message content occurs in older, headless, RPC-authored, or
  // /import'ed transcripts; string-typed cost fields in shared transcripts.
  const entries = [
    { type: "message", timestamp: iso(base), message: { role: "user", content: "plain string prompt" } },
    { type: "message", timestamp: iso(base + 1_000), message: { role: "assistant", content: "done", usage: { input: 10, cacheWrite: 0 } } },
    { type: "message", timestamp: iso(base + 6 * 60_000), message: { role: "user", content: "second" } },
    {
      type: "message",
      timestamp: iso(base + 6 * 60_000 + 1_000),
      message: { role: "assistant", content: "done", usage: { input: 1_000, cacheWrite: 500, cost: { cacheWrite: "0.09" } } },
    },
  ];
  const rates = { input: 3, cacheRead: 0.3, cacheWrite: 3.75 };
  const turns = reconstructHistory(entries, rates);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].promptText, "plain string prompt");
  // "0.09" coerced to 0 at the boundary, so the turn takes the estimate path
  // instead of crashing at toFixed in the badge/exports.
  assert.equal(turns[1].rewarm?.metered, false);
  assert.doesNotThrow(() => formatRewarmBadge(turns[1].rewarm));
});

test("dropInProgressTurn drops the transcript-tail pending turn despite clock drift", () => {
  const turns = [
    { promptText: "a", durationMs: 100, waitBeforeMs: 0, at: 1_000 },
    { promptText: "b", durationMs: 0, waitBeforeMs: 0, at: 2_000 },
  ];
  // The persisted user message landed 3 ms after the input event (hooks/image
  // normalization): exact-equality matching would keep the turn and render it
  // twice; positional matching drops it.
  assert.deepEqual(dropInProgressTurn(turns, 1_997).map((t) => t.promptText), ["a"]);
  // No pending turn was persisted (a short-circuited handler): nothing drops.
  assert.equal(dropInProgressTurn(turns, 3_000).length, 2);
  assert.equal(dropInProgressTurn(turns, null).length, 2);
  assert.equal(dropInProgressTurn([], 1_000).length, 0);
});

test("writeHistoryFile refuses to write through a symlinked directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompt-timer-"));
  const project = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(project);
  await mkdir(outside);
  await symlink(outside, join(project, ".scratch"));
  await assert.rejects(
    writeHistoryFile(".scratch/history.md", project, [], undefined, "markdown"),
    /symlink/,
  );
});

test("writeHistoryFile writes inside the project on the normal path", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompt-timer-"));
  await writeHistoryFile(".scratch/history.md", root, [], undefined, "markdown");
  const body = await readFile(join(root, ".scratch", "history.md"), "utf8");
  assert.match(body, /# Timer History/);
});
