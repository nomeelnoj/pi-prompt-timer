/**
 * Prompt Timer Extension
 *
 * SURFACES
 *   Footer (always visible, live-ticking every second)
 *     • Thinking  →  ⏱  1:23  started 14:32:05
 *     • Idle      →  ⌛ 4:32  · cache TTL expires in 0:28  @14:33:28  last: 15s
 *     • Idle ≥5m  →  red  ⚠ cache TTL expired · idle 12m  · ~$0.08 to rebuild  @14:33:28
 *       (the "to rebuild" estimate only appears once the model reports cache
 *       pricing; it is a labeled approximation, not a metered bill)
 *
 *   Title bar (only while a blocking prompt/overlay is open)
 *     The footer is occluded by prompt overlays (e.g. ask_user_question), so the
 *     cache-TTL countdown is mirrored into the terminal title bar, which no
 *     overlay can cover. Gated by MIRROR_TO_TITLE_DURING_PROMPTS. If the overlay
 *     is our own /timer history panel and the agent is still actively working
 *     underneath it, the title shows the "still working" elapsed time instead
 *     of the (possibly stale) idle countdown.
 *
 *   /timer command  +  ctrl+alt+t shortcut
 *     Opens a history overlay showing every turn's agent-response time with
 *     idle gaps > 30 s flagged as "waiting" rows (amber past 4 minutes, red
 *     past the 5-minute cache TTL, matching the footer's own bands). Press
 *     → or w to switch to the write-to-file tab, cycle the export format
 *     (Markdown / CSV / JSON), and write the history to disk.
 *
 * CACHE MODEL
 *   The prompt cache is server-side state whose TTL counts down from the last
 *   request that touched it. Any gap with no API traffic — idle at the prompt, a
 *   long-running tool, or a human-input wait (ask_user_question) — expires it
 *   identically. So the countdown is anchored to the last completed provider
 *   response (last assistant message end), not to agent-idle state.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_WARN_MS = 4 * 60 * 1000;

/**
 * Mirror the cache-TTL countdown into the terminal title bar while a blocking
 * prompt (ask_user_question, confirm, select, input, custom overlay) is open.
 * The footer is occluded by such overlays, but the title bar is never covered.
 * Set to false to disable all title-bar writes.
 */
const MIRROR_TO_TITLE_DURING_PROMPTS = true;

/** Idle gaps longer than this appear as an explicit "waiting" row in the history. */
const WAIT_THRESHOLD_MS = 30 * 1000;

/** Visible chars of prompt text in the overlay list. */
const PROMPT_PREVIEW = 55;

/** Export formats offered on the "Write to file" tab, in cycle order. */
const EXPORT_FORMATS = ["markdown", "csv", "json"] as const;
const FORMAT_LABELS = ["Markdown", "CSV", "JSON"] as const;
const FORMAT_EXTENSIONS: Record<ExportFormat, string> = { markdown: "md", csv: "csv", json: "json" };

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

type TurnRecord = {
  promptText: string;   // first line of prompt, truncated to PROMPT_PREVIEW
  durationMs: number;   // time from user pressing Enter → agent_settled
  waitBeforeMs: number; // idle gap between previous agent_settled and this Enter
  at: number;           // wall-clock ms of the Enter event
};

type DisplayRow =
  | { kind: "turn"; rec: TurnRecord }
  | { kind: "wait"; ms: number }
  | { kind: "live"; promptText: string; startedAt: number };

type ExportFormat = (typeof EXPORT_FORMATS)[number];

type OverlayResult =
  | { kind: "close" }
  | { kind: "write"; format: ExportFormat; target: "auto" | "custom" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(sec)}`;
  if (m > 0) return `${m}:${pad2(sec)}`;
  return `${sec}s`;
}

/**
 * Coarse duration for spans where second-level precision no longer matters
 * (for example, "how long has the cache been expired"). Drops seconds once
 * the span reaches a minute, and drops minutes once it reaches an hour, so
 * the number does not visually grow forever with jittery precision.
 */
export function formatDurationCoarse(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

type CacheLevel = "dim" | "warning" | "error";

/**
 * Severity band for an elapsed duration relative to the prompt-cache TTL:
 * dim below the warn threshold, warning between warn and TTL, error at or
 * past the TTL. Shared by the footer countdown and the history overlay's
 * "waiting" rows so both surfaces agree on when to escalate color.
 */
export function cacheLevel(elapsedMs: number): CacheLevel {
  if (elapsedMs >= CACHE_TTL_MS) return "error";
  if (elapsedMs >= CACHE_WARN_MS) return "warning";
  return "dim";
}

/**
 * Cache-TTL countdown text + severity, anchored to the last completed provider
 * response. The prompt cache is server-side state whose TTL counts down from the
 * last request that touched it, regardless of whether the client is idle, running
 * a long tool, or blocked waiting for a human answer.
 */
export function cacheCountdown(sinceMs: number, now: number): { text: string; level: CacheLevel } {
  const elapsed = Math.max(0, now - sinceMs);
  const level = cacheLevel(elapsed);
  if (level === "error") {
    const expiredFor = formatDurationCoarse(elapsed - CACHE_TTL_MS);
    return { text: `⚠ cache TTL expired · idle ${expiredFor}`, level };
  }
  const dur = formatDuration(elapsed);
  if (level === "warning") {
    const rem = formatDuration(Math.max(0, CACHE_TTL_MS - elapsed));
    return { text: `⌛ ${dur}  · cache TTL expires in ${rem}`, level };
  }
  return { text: `⌛ ${dur}`, level };
}

/** Per-million-token pricing pulled from `ctx.model.cost` at the time a cache was written. */
export type CacheCostRates = { input: number; cacheRead: number; cacheWrite: number };

/**
 * Estimated USD cost of letting a warm cache of `cachedTokens` expire, i.e.
 * what the next read of that context will cost instead of a cheap cache hit.
 *
 * Providers that charge a distinct cache-write rate (Anthropic-style explicit
 * caching) pay that rate to re-establish the cache. Providers that report no
 * cache-write rate (OpenAI/Gemini-style implicit caching) fall back to the
 * plain input rate, since those tokens simply become ordinary input tokens
 * again on a miss. This is always an approximation — the real bill also
 * depends on how much new content accumulated in the meantime — so callers
 * should present it as a labeled estimate, not a precise cost.
 *
 * Returns null when there is nothing to estimate: no cached tokens, or the
 * model reports no pricing at all (for example local/unknown models with
 * all-zero rates).
 */
export function estimateCacheMissCost(cachedTokens: number, rates: CacheCostRates | null): number | null {
  if (!rates || cachedTokens <= 0) return null;
  if (rates.input === 0 && rates.cacheRead === 0 && rates.cacheWrite === 0) return null; // no known pricing
  const missRate = rates.cacheWrite > 0 ? rates.cacheWrite : rates.input;
  const perTokenDelta = Math.max(0, missRate - rates.cacheRead);
  const cost = (cachedTokens * perTokenDelta) / 1_000_000;
  return cost > 0 ? cost : null;
}

/** Render a USD estimate compactly, flooring tiny amounts to a legible "<$0.01". */
export function formatEstimatedCost(usd: number): string {
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function truncatePrompt(text: string): string {
  const first = text.split("\n")[0] ?? text;
  return first.length <= PROMPT_PREVIEW ? first : first.slice(0, PROMPT_PREVIEW - 1) + "…";
}

/**
 * Strip C0/C1 control characters so interpolated values (session name, cwd)
 * cannot inject terminal escape sequences when written to the title bar.
 */
export function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/**
 * Resolve a user-supplied history path against cwd, returning the absolute
 * path only if it stays strictly inside cwd. Absolute paths, `..` escapes, and
 * the cwd itself are rejected (returns null). Keeps the custom save path
 * confined to the project directory.
 */
export function resolveWithinCwd(cwd: string, rel: string): string | null {
  if (!rel || nodePath.isAbsolute(rel)) return null;
  const root = nodePath.resolve(cwd);
  const resolved = nodePath.resolve(root, rel);
  if (resolved === root) return null; // must name a file, not the directory
  return resolved.startsWith(root + nodePath.sep) ? resolved : null;
}

/**
 * Reconstruct turn history from the session transcript. This is the source of
 * truth: real user/assistant messages always persist in the session file, so
 * history survives /reload and is recovered for pre-existing sessions.
 *
 * A "turn" spans from a user message to the last message before the next user
 * message (the agent's final activity). durationMs is that span; waitBeforeMs
 * is the idle gap between the previous turn's settle and this user message.
 */
export function reconstructHistory(entries: readonly unknown[]): TurnRecord[] {
  type MsgEntry = { type: string; timestamp?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
  const msgs = (entries as MsgEntry[]).filter(
    (e) => e.type === "message" && e.message != null && typeof e.timestamp === "string",
  );

  const turns: TurnRecord[] = [];
  let lastSettleMs: number | null = null;
  let i = 0;

  while (i < msgs.length) {
    const e = msgs[i]!;
    if (e.message?.role !== "user") {
      i++;
      continue;
    }

    const userMs = Date.parse(e.timestamp!);
    const text = (e.message.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join(" ")
      .trim();

    // Find the last message before the next user message.
    let j = i + 1;
    let lastActivityMs = userMs;
    while (j < msgs.length && msgs[j]!.message?.role !== "user") {
      const t = Date.parse(msgs[j]!.timestamp!);
      if (!Number.isNaN(t)) lastActivityMs = t;
      j++;
    }

    if (text.length > 0 && !Number.isNaN(userMs)) {
      turns.push({
        promptText: truncatePrompt(text),
        durationMs: Math.max(0, lastActivityMs - userMs),
        waitBeforeMs: lastSettleMs !== null ? Math.max(0, userMs - lastSettleMs) : 0,
        at: userMs,
      });
      lastSettleMs = lastActivityMs;
    }
    i = j;
  }

  return turns;
}

/** Pad or truncate a styled string to exactly `w` visible columns. */
function fillToWidth(s: string, w: number): string {
  const truncated = truncateToWidth(s, w);
  return truncated + " ".repeat(Math.max(0, w - visibleWidth(truncated)));
}

/**
 * Find the most recent assistant message's cache usage in the raw session
 * transcript. Used to restore the cache-miss-cost estimate on /reload,
 * mirroring how lastProviderResponseAt/lastRunMs are restored from history.
 */
export function findLastAssistantUsage(entries: readonly unknown[]): { cacheRead: number; cacheWrite: number } | null {
  type UsageEntry = { type: string; message?: { role?: string; usage?: { cacheRead?: number; cacheWrite?: number } } };
  const msgs = entries as UsageEntry[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.type === "message" && m.message?.role === "assistant" && m.message.usage) {
      return { cacheRead: m.message.usage.cacheRead ?? 0, cacheWrite: m.message.usage.cacheWrite ?? 0 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// History file rendering (Markdown / CSV / JSON)
// ---------------------------------------------------------------------------

export type HistoryFileMeta = { date: Date; sessionName?: string; cwd: string };

export function renderHistoryMarkdown(history: TurnRecord[], meta: HistoryFileMeta): string {
  const lines: string[] = ["# Timer History", "", `**Date:** ${meta.date.toLocaleString()}`];
  if (meta.sessionName) lines.push(`**Session:** ${meta.sessionName}`);
  lines.push(`**CWD:** ${meta.cwd}`, "", "---", "");

  if (history.length === 0) {
    lines.push("*(no history yet)*");
  } else {
    for (const rec of history) {
      if (rec.waitBeforeMs >= WAIT_THRESHOLD_MS) {
        lines.push(`⌛ ${formatDuration(rec.waitBeforeMs).padStart(5)}   waiting`);
        lines.push("");
      }
      const dur = formatDuration(rec.durationMs).padStart(5);
      lines.push(`${dur}  ↑  ${rec.promptText}   [${formatTimestamp(rec.at)}]`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function renderHistoryCsv(history: TurnRecord[]): string {
  const header = "timestamp,duration_ms,duration,wait_before_ms,prompt";
  const rows = history.map((rec) =>
    [
      formatTimestamp(rec.at),
      String(rec.durationMs),
      formatDuration(rec.durationMs),
      String(rec.waitBeforeMs),
      csvEscape(rec.promptText),
    ].join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

export function renderHistoryJson(history: TurnRecord[], meta: HistoryFileMeta): string {
  const payload = {
    date: meta.date.toISOString(),
    session: meta.sessionName ?? null,
    cwd: meta.cwd,
    turns: history.map((rec) => ({
      at: new Date(rec.at).toISOString(),
      timestamp: formatTimestamp(rec.at),
      durationMs: rec.durationMs,
      duration: formatDuration(rec.durationMs),
      waitBeforeMs: rec.waitBeforeMs,
      prompt: rec.promptText,
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function renderHistoryContent(format: ExportFormat, history: TurnRecord[], meta: HistoryFileMeta): string {
  if (format === "csv") return renderHistoryCsv(history);
  if (format === "json") return renderHistoryJson(history, meta);
  return renderHistoryMarkdown(history, meta);
}

// ---------------------------------------------------------------------------
// TimerHistoryComponent
// ---------------------------------------------------------------------------

export class TimerHistoryComponent {
  private selected = 0;
  private readonly rows: DisplayRow[];
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  /** Active tab: 0 = History, 1 = Write to file. */
  private tab: 0 | 1 = 0;
  /** Write-to-file row: 0 = format, 1 = auto path, 2 = choose a relative path. */
  private writeSelected: 0 | 1 | 2 = 1;
  /** Index into EXPORT_FORMATS for the currently selected export format. */
  private writeFormat: 0 | 1 | 2 = 0;

  constructor(
    history: TurnRecord[],
    liveEntry: { promptText: string; startedAt: number } | null,
    private readonly sessionName: string | undefined,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly doneFn: (result: OverlayResult) => void,
  ) {
    this.rows = TimerHistoryComponent.buildRows(history, liveEntry);
    if (liveEntry) {
      this.liveTimer = setInterval(() => tui.requestRender(), 1000);
    }
  }

  private static buildRows(
    history: TurnRecord[],
    liveEntry: { promptText: string; startedAt: number } | null,
  ): DisplayRow[] {
    const out: DisplayRow[] = [];
    for (const rec of history) {
      if (rec.waitBeforeMs >= WAIT_THRESHOLD_MS) {
        out.push({ kind: "wait", ms: rec.waitBeforeMs });
      }
      out.push({ kind: "turn", rec });
    }
    if (liveEntry) {
      out.push({ kind: "live", ...liveEntry });
    }
    return out;
  }

  private done(result: OverlayResult): void {
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
    this.doneFn(result);
  }

  private currentFormat(): ExportFormat {
    return EXPORT_FORMATS[this.writeFormat]!;
  }

  private currentAutoPath(): string {
    return buildDefaultPath(this.sessionName, this.currentFormat());
  }

  /** Draw the top tab strip (History │ Write to file); active tab highlighted. */
  private renderTabStrip(innerWidth: number): string {
    const t = this.theme;
    const labels = ["History", "Write to file"];
    let out = "";
    let vis = 0;
    for (let i = 0; i < labels.length; i++) {
      if (i > 0) {
        out += t.fg("border", "│");
        vis += 1;
      }
      const cell = ` ${labels[i]} `;
      out += i === this.tab ? t.fg("accent", cell) : t.fg("dim", cell);
      vis += visibleWidth(cell);
    }
    return out + " ".repeat(Math.max(0, innerWidth - vis));
  }

  private setTab(tab: 0 | 1): void {
    if (this.tab === tab) return;
    this.tab = tab;
    if (tab === 1) this.writeSelected = 1; // land on the primary "save" action
    this.tui.requestRender(true); // structural change → full repaint
  }

  private renderRow(row: DisplayRow, selected: boolean, innerWidth: number): string {
    const t = this.theme;
    const prefix = selected ? t.fg("accent", " ❯ ") : "   ";
    const contentWidth = innerWidth - 3; // 3 for prefix

    if (row.kind === "wait") {
      const dur = formatDuration(row.ms).padStart(5);
      // Same dim → amber → red escalation the footer uses, so a "waiting" row
      // signals how close (or how far past) the cache TTL it ran.
      const level = cacheLevel(row.ms);
      if (level === "error") {
        return prefix + fillToWidth(t.fg("error", `${dur}  ⌛  waiting · cache TTL expired`), contentWidth);
      }
      if (level === "warning") {
        return prefix + fillToWidth(t.fg("warning", `${dur}  ⌛  waiting`), contentWidth);
      }
      return prefix + fillToWidth(t.fg("dim", `${dur}  ⌛  waiting`), contentWidth);
    }

    if (row.kind === "turn") {
      const dur = formatDuration(row.rec.durationMs).padStart(5);
      const arrowWidth = 5; // "  ↑  "
      const labelMaxWidth = contentWidth - 5 - arrowWidth;
      const label = truncateToWidth(row.rec.promptText, labelMaxWidth);
      const durStr = selected ? t.fg("accent", dur) : t.fg("dim", dur);
      const arrow = selected ? t.fg("accent", "  ↑  ") : t.fg("dim", "  ↑  ");
      const labelStr = selected ? label : t.fg("dim", label);
      return prefix + fillToWidth(durStr + arrow + labelStr, contentWidth);
    }

    // live (in-progress turn)
    const elapsed = Math.max(0, Date.now() - row.startedAt);
    const dur = formatDuration(elapsed).padStart(5);
    const arrowWidth = 5;
    const suffixWidth = 12; // " (running…)"
    const labelMaxWidth = contentWidth - 5 - arrowWidth - suffixWidth;
    const label = truncateToWidth(row.promptText, Math.max(0, labelMaxWidth));
    const running = t.fg("dim", "  (running…)");
    return prefix + fillToWidth(t.fg("accent", `${dur}  ⏱  ${label}`) + running, contentWidth);
  }

  render(width: number): string[] {
    const innerWidth = width - 2;
    const border = (s: string) => this.theme.fg("border", s);
    const t = this.theme;
    const CONTENT_ROWS = 12; // fixed content height so the box never jumps

    const lines: string[] = [];
    // ── Box top + tab strip header (History │ Write to file) ────────────────
    lines.push(border("┌") + border("─".repeat(innerWidth)) + border("┐"));
    lines.push(border("│") + this.renderTabStrip(innerWidth) + border("│"));
    lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));

    // ── Tab body ────────────────────────────────────────────────────────────
    const content: string[] = [];
    if (this.tab === 0) {
      const waitS = WAIT_THRESHOLD_MS / 1000;
      const ttlMin = CACHE_TTL_MS / 60_000;
      content.push(
        fillToWidth(t.fg("dim", `   waiting ≥ ${waitS}s · red once past the ${ttlMin}-minute cache TTL`), innerWidth),
      );
      if (this.rows.length === 0) {
        content.push(" ".repeat(innerWidth));
        content.push(fillToWidth(t.fg("dim", "   (no history yet)"), innerWidth));
        content.push(fillToWidth(t.fg("dim", "   Send a prompt to start tracking timing."), innerWidth));
      } else {
        const listRows = CONTENT_ROWS - content.length;
        this.selected = Math.max(0, Math.min(this.selected, this.rows.length - 1));
        const scrollStart = Math.max(0, this.selected - listRows + 1);
        const visible = this.rows.slice(scrollStart, scrollStart + listRows);
        for (let i = 0; i < visible.length; i++) {
          const isActive = scrollStart + i === this.selected;
          content.push(fillToWidth(this.renderRow(visible[i]!, isActive, innerWidth), innerWidth));
        }
      }
    } else {
      content.push(fillToWidth(t.fg("dim", "   Save the timer history as:"), innerWidth));
      content.push(" ".repeat(innerWidth));

      const formatRow = (): string => {
        const active = this.writeSelected === 0;
        const prefix = active ? t.fg("accent", "  ❯ ") : "    ";
        let chips = t.fg("dim", "Format:  ");
        for (let i = 0; i < FORMAT_LABELS.length; i++) {
          if (i > 0) chips += t.fg("dim", " │ ");
          chips += i === this.writeFormat ? t.fg("accent", FORMAT_LABELS[i]!) : t.fg("dim", FORMAT_LABELS[i]!);
        }
        return prefix + chips;
      };
      content.push(fillToWidth(formatRow(), innerWidth));
      content.push(" ".repeat(innerWidth));

      const optionRow = (idx: 1 | 2, label: string): string => {
        const active = this.writeSelected === idx;
        const prefix = active ? t.fg("accent", "  ❯ ") : "    ";
        return prefix + (active ? t.fg("accent", label) : t.fg("dim", label));
      };
      content.push(fillToWidth(optionRow(1, truncateToWidth(this.currentAutoPath(), innerWidth - 6)), innerWidth));
      content.push(fillToWidth(optionRow(2, "Choose a relative path…"), innerWidth));
    }

    while (content.length < CONTENT_ROWS) content.push(" ".repeat(innerWidth));
    for (const c of content.slice(0, CONTENT_ROWS)) {
      lines.push(border("│") + c + border("│"));
    }
    lines.push(border("└") + border("─".repeat(innerWidth)) + border("┘"));

    // ── Hint line (below the box) ────────────────────────────────────────────
    const hint =
      this.tab === 0
        ? "  ↑↓ / j k  navigate  ·  →  write to file  ·  tab  switch tabs  ·  esc / q  close  "
        : this.writeSelected === 0
          ? "  ↑↓  select  ·  enter  cycle format  ·  ←  history  ·  esc  close  "
          : "  ↑↓  select  ·  enter  save  ·  ←  history  ·  esc  close  ";
    lines.push(t.fg("dim", truncateToWidth(hint, width)));
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
      this.done({ kind: "close" });
      return;
    }
    // Tab strip navigation
    if (matchesKey(data, Key.left)) {
      this.setTab(0);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.setTab(1);
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, "shift+tab")) {
      this.setTab(this.tab === 0 ? 1 : 0);
      return;
    }
    if (data === "w") {
      this.setTab(1);
      return;
    }

    if (this.tab === 1) {
      // Write-to-file rows: 0 = format, 1 = auto path, 2 = custom path. Up/down
      // wraps since it is a short cyclic menu.
      if (matchesKey(data, Key.up)) {
        this.writeSelected = this.writeSelected === 0 ? 2 : ((this.writeSelected - 1) as 0 | 1 | 2);
        this.tui.requestRender();
      } else if (matchesKey(data, Key.down)) {
        this.writeSelected = this.writeSelected === 2 ? 0 : ((this.writeSelected + 1) as 0 | 1 | 2);
        this.tui.requestRender();
      } else if (matchesKey(data, Key.enter)) {
        if (this.writeSelected === 0) {
          this.writeFormat = ((this.writeFormat + 1) % EXPORT_FORMATS.length) as 0 | 1 | 2;
          this.tui.requestRender();
        } else {
          this.done({
            kind: "write",
            format: this.currentFormat(),
            target: this.writeSelected === 1 ? "auto" : "custom",
          });
        }
      }
      return;
    }

    // History list
    const count = Math.max(this.rows.length, 1);
    if (matchesKey(data, Key.up) || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.tui.requestRender();
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.selected = Math.min(count - 1, this.selected + 1);
      this.tui.requestRender();
    }
  }
  invalidate(): void {
    // Force a full repaint on theme changes so structural layout is always consistent
    this.tui.requestRender(true);
  }
}

// ---------------------------------------------------------------------------
// File writing
// ---------------------------------------------------------------------------

export function buildDefaultPath(sessionName: string | undefined, format: ExportFormat = "markdown"): string {
  const now = new Date();
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}-${pad2(now.getMinutes())}`;
  const core =
    sessionName != null
      ? sessionName
          .replace(/[^a-z0-9]+/gi, "-")
          .toLowerCase()
          .slice(0, 40)
          .replace(/^-+|-+$/g, "")
      : "";
  const slug = core.length > 0 ? `-${core}` : "";
  const ext = FORMAT_EXTENSIONS[format];
  // Return a cwd-relative path so it fits in the overlay without truncation.
  return nodePath.join(".scratch", `timer-${date}-${time}${slug}.${ext}`);
}

async function writeHistoryFile(
  filePath: string,
  cwd: string,
  history: TurnRecord[],
  sessionName: string | undefined,
  format: ExportFormat,
): Promise<void> {
  // filePath is always cwd-relative (auto path or a caller-validated custom
  // path), so resolve it against cwd; the project dir contains the output.
  const resolved = nodePath.resolve(cwd, filePath);
  const body = renderHistoryContent(format, history, { date: new Date(), sessionName, cwd });
  await nodeFs.promises.mkdir(nodePath.dirname(resolved), { recursive: true });
  await nodeFs.promises.writeFile(resolved, body, "utf8");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function promptTimer(pi: ExtensionAPI) {
  // ── State ─────────────────────────────────────────────────────────────────
  let thinkingStartMs: number | null = null;
  let lastRunMs: number | null = null;
  // Anchor for the cache-TTL countdown: when the last provider response
  // completed (last assistant message end). Ticks down during idle, long tool
  // runs, and human-input waits (ask_user_question) alike.
  let lastProviderResponseAt: number | null = null;
  // Cache usage/pricing snapshot from that same last provider response, used
  // to estimate the cost of a cache miss once the TTL has expired.
  let lastCachedTokens = 0;
  let lastCacheCostRates: CacheCostRates | null = null;
  let pendingPromptText = "";
  let pendingInputAt: number | null = null;
  // True while a blocking user-facing prompt/overlay is open.
  let uiPromptActive = false;
  // True specifically while our own /timer history overlay is open. Lets the
  // title mirror distinguish "the agent is still working underneath our own
  // panel" from "the agent itself opened a blocking prompt (ask_user_question)",
  // which the footer already treats as an idle/cache-countdown state.
  let ownOverlayOpen = false;

  let footerTui: { requestRender(): void } | null = null;
  let titleUi: { setTitle(t: string): void } | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  // ── Title-bar helpers ───────────────────────────────────────────────────────

  function baseTitle(): string {
    const cwd = stripControlChars(nodePath.basename(process.cwd()));
    const name = pi.getSessionName();
    const safeName = name ? stripControlChars(name) : "";
    return safeName ? `π - ${safeName} - ${cwd}` : `π - ${cwd}`;
  }

  /** Paint the cache-TTL countdown (or "still working") into the title while a prompt is open. */
  function refreshPromptTitle(): void {
    if (!titleUi) return;
    if (ownOverlayOpen && thinkingStartMs !== null) {
      const elapsed = Date.now() - thinkingStartMs;
      titleUi.setTitle(`⏱ ${formatDuration(elapsed)}  ·  ${baseTitle()}`);
      return;
    }
    if (lastProviderResponseAt === null) {
      titleUi.setTitle(baseTitle());
      return;
    }
    const st = cacheCountdown(lastProviderResponseAt, Date.now());
    titleUi.setTitle(`${st.text}  ·  ${baseTitle()}`);
  }

  function restoreTitle(): void {
    if (titleUi) titleUi.setTitle(baseTitle());
  }

  // ── Tick loop ──────────────────────────────────────────────────────────────

  function startTick(): void {
    if (tickTimer !== null) return;
    tickTimer = setInterval(() => {
      footerTui?.requestRender();
      if (MIRROR_TO_TITLE_DURING_PROMPTS && uiPromptActive) refreshPromptTitle();
    }, 1000);
  }

  function stopTick(): void {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  // ── History overlay ────────────────────────────────────────────────────────

  async function showHistory(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Timer history requires TUI mode", "warning");
      return;
    }

    const liveEntry =
      thinkingStartMs !== null && pendingInputAt !== null
        ? { promptText: pendingPromptText, startedAt: pendingInputAt }
        : null;

    // Reconstruct completed turns from the in-memory session transcript.
    // (getEntries() is synchronous/in-memory — no disk read, no LLM-context cost.)
    const allTurns = reconstructHistory(ctx.sessionManager.getEntries());
    // Drop the in-progress turn (shown separately as the live row).
    const history = liveEntry
      ? allTurns.filter((tn) => tn.at !== liveEntry.startedAt)
      : allTurns;

    const sessionName = pi.getSessionName() ?? undefined;

    let result: OverlayResult;
    ownOverlayOpen = true;
    try {
      result = await ctx.ui.custom<OverlayResult>(
        (tui, theme, _kb, done) => new TimerHistoryComponent(history, liveEntry, sessionName, tui, theme, done),
        {
          overlay: true,
          overlayOptions: { width: "72%", minWidth: 54, maxHeight: "80%", anchor: "center" },
        },
      );
    } finally {
      ownOverlayOpen = false;
    }

    if (result.kind !== "write") return;

    const path = result.target === "auto" ? buildDefaultPath(sessionName, result.format) : null;
    if (path !== null) {
      try {
        await writeHistoryFile(path, ctx.cwd, history, sessionName, result.format);
        ctx.ui.notify(`Saved → ${nodePath.resolve(ctx.cwd, path)}`, "info");
      } catch (err) {
        ctx.ui.notify(`Write failed: ${(err as Error).message}`, "error");
      }
      return;
    }

    const suggested = buildDefaultPath(sessionName, result.format);
    const input = await ctx.ui.input(
      "Save timer history — path relative to the project directory",
      suggested,
    );
    const rel = input?.trim();
    if (!rel) return;
    // Confine the custom path to inside cwd: no absolute paths, no `..` escapes.
    const resolved = resolveWithinCwd(ctx.cwd, rel);
    if (!resolved) {
      ctx.ui.notify(
        "Path must be relative to the project directory (no absolute or ../ paths).",
        "error",
      );
      return;
    }
    try {
      await writeHistoryFile(rel, ctx.cwd, history, sessionName, result.format);
      ctx.ui.notify(`Saved → ${resolved}`, "info");
    } catch (err) {
      ctx.ui.notify(`Write failed: ${(err as Error).message}`, "error");
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  pi.on("input", async (event) => {
    if (event.source === "extension") return;
    pendingPromptText = truncatePrompt(event.text);
    pendingInputAt = Date.now();
  });

  pi.on("agent_start", async () => {
    if (thinkingStartMs === null) thinkingStartMs = Date.now();
    footerTui?.requestRender();
    startTick();
  });

  // Last provider round-trip completed — the moment the cache was (re)written.
  // Fires before tool execution, so an ask_user_question wait is anchored here.
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    lastProviderResponseAt = Date.now();
    const usage = event.message.usage;
    lastCachedTokens = (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
    lastCacheCostRates = ctx.model?.cost
      ? { input: ctx.model.cost.input, cacheRead: ctx.model.cost.cacheRead, cacheWrite: ctx.model.cost.cacheWrite }
      : null;
  });

  // Blocking user-facing prompt opened/closed (ask_user_question, confirm,
  // select, input, custom overlay). Mirror the cache countdown into the title
  // bar since the footer is occluded by the overlay.
  pi.on("ui_prompt_start", async (_event, ctx) => {
    uiPromptActive = true;
    if (MIRROR_TO_TITLE_DURING_PROMPTS && ctx.hasUI) {
      titleUi = ctx.ui;
      refreshPromptTitle();
      startTick();
    }
  });

  pi.on("ui_prompt_end", async () => {
    uiPromptActive = false;
    if (MIRROR_TO_TITLE_DURING_PROMPTS) restoreTitle();
  });

  pi.on("agent_settled", async () => {
    const now = Date.now();
    if (thinkingStartMs !== null && pendingInputAt !== null) {
      lastRunMs = now - thinkingStartMs;
    }
    if (lastProviderResponseAt === null) lastProviderResponseAt = now;
    thinkingStartMs = null;
    pendingInputAt = null;
    footerTui?.requestRender();
    startTick();
  });

  pi.on("session_start", async (_event, ctx) => {
    // Reset ephemeral per-turn state.
    thinkingStartMs = null;
    lastRunMs = null;
    lastProviderResponseAt = null;
    lastCachedTokens = 0;
    lastCacheCostRates = null;
    pendingPromptText = "";
    pendingInputAt = null;
    uiPromptActive = false;
    ownOverlayOpen = false;

    // Restore the cache anchor from the transcript so /reload (which preserves
    // context, hence the live prompt cache) keeps the cache-TTL clock ticking.
    // A genuinely new session has no turns, so the footer stays empty (—).
    const turns = reconstructHistory(ctx.sessionManager.getEntries());
    const lastTurn = turns[turns.length - 1];
    if (lastTurn) {
      lastProviderResponseAt = lastTurn.at + lastTurn.durationMs;
      lastRunMs = lastTurn.durationMs;
    }
    const lastUsage = findLastAssistantUsage(ctx.sessionManager.getEntries());
    if (lastUsage) {
      lastCachedTokens = lastUsage.cacheRead + lastUsage.cacheWrite;
      lastCacheCostRates = ctx.model?.cost
        ? { input: ctx.model.cost.input, cacheRead: ctx.model.cost.cacheRead, cacheWrite: ctx.model.cost.cacheWrite }
        : null;
    }

    if (!ctx.hasUI) return;
    titleUi = ctx.ui;

    ctx.ui.setFooter((tui, theme, footerData) => {
      footerTui = tui;
      const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
      startTick();

      return {
        dispose() { unsubBranch(); footerTui = null; },
        invalidate() {},
        render(width: number): string[] {
          const now = Date.now();
          let left: string;

          if (thinkingStartMs !== null && !uiPromptActive) {
            // Agent actively working (not blocked on a human prompt).
            const elapsed = now - thinkingStartMs;
            left = theme.fg("accent", `⏱  ${formatDuration(elapsed)}  started ${formatTimestamp(thinkingStartMs)}`);
          } else if (lastProviderResponseAt !== null) {
            // Idle at prompt, long tool run, or waiting on a human answer — all
            // expire the cache identically, so show the countdown from the last
            // provider response.
            const st = cacheCountdown(lastProviderResponseAt, now);
            left = theme.fg(st.level, st.text);
            if (st.level === "error") {
              const estimate = estimateCacheMissCost(lastCachedTokens, lastCacheCostRates);
              if (estimate !== null) {
                left += theme.fg("error", `  · ~${formatEstimatedCost(estimate)} to rebuild`);
              }
            }
            left += theme.fg("dim", `  @${formatTimestamp(lastProviderResponseAt)}`);
          } else {
            left = theme.fg("dim", "—");
          }

          if (lastRunMs !== null && thinkingStartMs === null) {
            left += theme.fg("dim", `   last: ${formatDuration(lastRunMs)}`);
          }

          const branch = footerData.getGitBranch();
          const parts = [ctx.model?.id ?? "", branch ? `(${branch})` : ""].filter(Boolean);
          const right = parts.length > 0 ? theme.fg("dim", parts.join(" ")) : "";
          const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
          return [truncateToWidth(left + " ".repeat(gap) + right, width)];
        },
      };
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopTick();
    footerTui = null;
    thinkingStartMs = null;
    uiPromptActive = false;
    ownOverlayOpen = false;
    if (ctx.hasUI) {
      ctx.ui.setFooter(undefined);
      if (MIRROR_TO_TITLE_DURING_PROMPTS) ctx.ui.setTitle(baseTitle());
    }
    titleUi = null;
  });

  // ── Commands & shortcuts ───────────────────────────────────────────────────

  pi.registerCommand("timer", {
    description: "Show timing history for this session (agent duration per prompt + idle gaps)",
    handler: (_args, ctx) => showHistory(ctx),
  });

  pi.registerShortcut("ctrl+alt+t", {
    description: "Show session timing history",
    handler: (ctx) => showHistory(ctx),
  });
}
