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
  truncatePrompt,
  buildDefaultPath,
  reconstructHistory,
  stripControlChars,
  resolveWithinCwd,
  renderHistoryMarkdown,
  renderHistoryCsv,
  renderHistoryJson,
} = await jiti.import(extensionPath);

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
  assert.equal(lines[0], "timestamp,duration_ms,duration,wait_before_ms,prompt");
  // Timestamp formatting is local-time (formatTimestamp), so only assert its
  // shape here; duration/wait/prompt fields are timezone-independent.
  assert.match(lines[1], /^\d{2}:\d{2}:\d{2},1500,1s,0,"has, comma ""and quotes"""$/);
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
