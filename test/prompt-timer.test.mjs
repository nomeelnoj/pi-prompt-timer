import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

// Load the TypeScript extension through jiti and pull out the exported pure
// helpers. These functions carry no TUI/session state, so they are exercised
// directly here.
const jiti = createJiti(import.meta.url, { moduleCache: false });
const extensionPath = fileURLToPath(new URL("../extensions/prompt-timer/index.ts", import.meta.url));
const { formatDuration, cacheCountdown, truncatePrompt, buildDefaultPath, reconstructHistory } =
  await jiti.import(extensionPath);

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
