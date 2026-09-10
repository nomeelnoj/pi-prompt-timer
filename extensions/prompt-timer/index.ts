/**
 * Prompt Timer Extension
 *
 * SURFACES
 *   Footer (always visible, live-ticking every second)
 *     • Thinking  →  ⏱  1:23  started 14:32:05
 *     • Idle      →  ⌛ 4:32  · cache TTL expires in 0:28  @14:33:28  last: 15s
 *     • Idle ≥5m  →  red  ⚠ cache TTL expired
 *
 *   Title bar (only while a blocking prompt/overlay is open)
 *     The footer is occluded by prompt overlays (e.g. ask_user_question), so the
 *     cache-TTL countdown is mirrored into the terminal title bar, which no
 *     overlay can cover. Gated by MIRROR_TO_TITLE_DURING_PROMPTS.
 *
 *   /timer command  +  ctrl+alt+t shortcut
 *     Opens a history overlay showing every turn's agent-response time with
 *     idle gaps > 30 s flagged as "waiting" rows (red past the cache TTL).
 *     Press → or w to write the history to a Markdown file.
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

type OverlayResult = "close" | "write-auto" | "write-custom";

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

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

type CacheLevel = "dim" | "warning" | "error";

/**
 * Cache-TTL countdown text + severity, anchored to the last completed provider
 * response. The prompt cache is server-side state whose TTL counts down from the
 * last request that touched it, regardless of whether the client is idle, running
 * a long tool, or blocked waiting for a human answer.
 */
export function cacheCountdown(sinceMs: number, now: number): { text: string; level: CacheLevel } {
  const elapsed = Math.max(0, now - sinceMs);
  const dur = formatDuration(elapsed);
  if (elapsed >= CACHE_TTL_MS) {
    return { text: `⌛ ${dur}  ⚠ cache TTL expired`, level: "error" };
  }
  if (elapsed >= CACHE_WARN_MS) {
    const rem = formatDuration(Math.max(0, CACHE_TTL_MS - elapsed));
    return { text: `⌛ ${dur}  · cache TTL expires in ${rem}`, level: "warning" };
  }
  return { text: `⌛ ${dur}`, level: "dim" };
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

// ---------------------------------------------------------------------------
// TimerHistoryComponent
// ---------------------------------------------------------------------------

class TimerHistoryComponent {
  private selected = 0;
  private readonly rows: DisplayRow[];
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  /** Whether the write-panel is open at the top of the overlay. */
  private writeMode = false;
  /** 0 = auto path, 1 = choose own location */
  private writeSelected: 0 | 1 = 0;

  constructor(
    history: TurnRecord[],
    liveEntry: { promptText: string; startedAt: number } | null,
    private readonly autoPath: string,
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

  private renderRow(row: DisplayRow, selected: boolean, innerWidth: number): string {
    const t = this.theme;
    const prefix = selected ? t.fg("accent", " ❯ ") : "   ";
    const contentWidth = innerWidth - 3; // 3 for prefix

    if (row.kind === "wait") {
      const dur = formatDuration(row.ms).padStart(5);
      // Red once the idle gap exceeded the prompt-cache TTL — the cache was
      // gone by the time the next prompt landed.
      if (row.ms >= CACHE_TTL_MS) {
        return prefix + fillToWidth(t.fg("error", `${dur}  ⌛  waiting · cache TTL expired`), contentWidth);
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

    // Fixed content budget: spacer(1) + list rows, or write-panel(4) + list rows.
    // Keep total box height constant so it never jumps between modes.
    const CONTENT_ROWS = 15; // spacer + up-to-14 list rows
    const writePanelRows = 4; // title + opt0 + opt1 + separator
    const maxListRows = this.writeMode
      ? Math.min(Math.max(this.rows.length, 1), CONTENT_ROWS - writePanelRows)
      : Math.min(Math.max(this.rows.length, 1), CONTENT_ROWS - 1);

    if (this.rows.length > 0) {
      this.selected = Math.max(0, Math.min(this.selected, this.rows.length - 1));
    }

    const scrollStart = Math.max(0, this.selected - maxListRows + 1);
    const visibleRows  = this.rows.slice(scrollStart, scrollStart + maxListRows);
    const lines: string[] = [];

    // ── Outer title (always the same) ──────────────────────────────────────
    const outerTitle = "  ⏱  Timer History  ";
    const outerFill  = "─".repeat(Math.max(0, innerWidth - visibleWidth(outerTitle)));
    lines.push(border("┌") + t.fg("accent", outerTitle) + border(outerFill) + border("┐"));

    // ── Write panel (immediately below outer title when active) ──────────
    if (this.writeMode) {
      // Titled section header using ├/┤ T-junctions
      const panelTitle = " Write to file ";
      const panelFill  = border("─".repeat(Math.max(0, innerWidth - visibleWidth(panelTitle))));
      lines.push(border("├") + t.fg("accent", panelTitle) + panelFill + border("┤"));

      // Option 0 — auto path
      const autoLabel  = truncateToWidth(this.autoPath, innerWidth - 4);
      const autoPrefix = this.writeSelected === 0 ? t.fg("accent", "  ❯ ") : "    ";
      const autoText   = this.writeSelected === 0 ? t.fg("accent", autoLabel) : t.fg("dim", autoLabel);
      lines.push(border("│") + fillToWidth(autoPrefix + autoText, innerWidth) + border("│"));

      // Option 1 — custom location
      const customLabel  = "Choose a relative path…";
      const customPrefix = this.writeSelected === 1 ? t.fg("accent", "  ❯ ") : "    ";
      const customText   = this.writeSelected === 1 ? t.fg("accent", customLabel) : t.fg("dim", customLabel);
      lines.push(border("│") + fillToWidth(customPrefix + customText, innerWidth) + border("│"));

      // Closing separator using ├/┤ so history below is visually separated
      lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
    } else {
      // Blank spacer (normal mode)
      lines.push(border("│") + " ".repeat(innerWidth) + border("│"));
    }

    // ── History rows ──────────────────────────────────────────────────
    if (this.rows.length === 0) {
      lines.push(border("│") + fillToWidth(t.fg("dim", "   (no history yet)"), innerWidth) + border("│"));
    } else {
      for (let i = 0; i < visibleRows.length; i++) {
        const globalIdx = scrollStart + i;
        const isActive  = !this.writeMode && globalIdx === this.selected;
        const content   = this.renderRow(visibleRows[i]!, isActive, innerWidth);
        const row = this.writeMode
          ? border("│") + fillToWidth(t.fg("dim", content), innerWidth) + border("│")
          : border("│") + fillToWidth(content, innerWidth) + border("│");
        lines.push(row);
      }
    }

    // ── Pad to constant height ───────────────────────────────────────
    const targetContentLines = 1 + CONTENT_ROWS; // outer title + content budget
    while (lines.length < targetContentLines) {
      lines.push(border("│") + " ".repeat(innerWidth) + border("│"));
    }
    lines.push(border("└") + border("─".repeat(innerWidth)) + border("┘"));

    // ── Hint ─────────────────────────────────────────────────────────
    const scrollNote = this.rows.length > maxListRows ? " • ↑↓ scroll" : "";
    const hint = this.writeMode
      ? "  ↑↓  navigate  ·  enter  confirm  ·  esc  dismiss  "
      : `  ↑↓ / j k  navigate${scrollNote}  ·  → / w  write to file  ·  esc / q  close  `;
    lines.push(t.fg("dim", truncateToWidth(hint, width)));
    return lines;
  }

  handleInput(data: string): void {
    if (this.writeMode) {
      // ── Write panel navigation ───────────────────────────────────────
      if (matchesKey(data, Key.up)) {
        this.writeSelected = 0;
        this.tui.requestRender();
      } else if (matchesKey(data, Key.down)) {
        this.writeSelected = 1;
        this.tui.requestRender();
      } else if (matchesKey(data, Key.enter)) {
        this.done(this.writeSelected === 0 ? "write-auto" : "write-custom");
      } else if (matchesKey(data, Key.escape)) {
        // Dismiss write panel — full repaint to restore history layout
        this.writeMode = false;
        this.tui.requestRender(true);
      }
      return;
    }

    // ── History navigation ─────────────────────────────────────────────
    const count = Math.max(this.rows.length, 1);
    if (matchesKey(data, Key.up) || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.tui.requestRender();
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.selected = Math.min(count - 1, this.selected + 1);
      this.tui.requestRender();
    } else if (matchesKey(data, Key.right) || data === "w" || data === "\x1b[C") {
      // Open write panel — force full repaint so structural layout change is fully flushed
      this.writeMode = true;
      this.writeSelected = 0;
      this.tui.requestRender(true);
    } else if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
      this.done("close");
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

export function buildDefaultPath(sessionName: string | undefined): string {
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
  // Return a cwd-relative path so it fits in the overlay without truncation.
  return nodePath.join(".scratch", `timer-${date}-${time}${slug}.md`);
}

async function writeHistoryFile(
  filePath: string,
  cwd: string,
  history: TurnRecord[],
  sessionName: string | undefined,
): Promise<void> {
  // filePath is always cwd-relative (auto path or a caller-validated custom
  // path), so resolve it against cwd; the project dir contains the output.
  const resolved = nodePath.resolve(cwd, filePath);
  const now = new Date();
  const lines: string[] = [
    "# Timer History",
    "",
    `**Date:** ${now.toLocaleString()}`,
  ];
  if (sessionName) lines.push(`**Session:** ${sessionName}`);
  lines.push(`**CWD:** ${cwd}`, "", "---", "");

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

  await nodeFs.promises.mkdir(nodePath.dirname(resolved), { recursive: true });
  await nodeFs.promises.writeFile(resolved, lines.join("\n"), "utf8");
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
  let pendingPromptText = "";
  let pendingInputAt: number | null = null;
  // True while a blocking user-facing prompt/overlay is open.
  let uiPromptActive = false;

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

  /** Paint the cache-TTL countdown into the title while a prompt is open. */
  function refreshPromptTitle(): void {
    if (!titleUi) return;
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

    const sessionName = pi.getSessionName();
    const autoPath = buildDefaultPath(sessionName ?? undefined);

    const result = await ctx.ui.custom<OverlayResult>(
      (tui, theme, _kb, done) =>
        new TimerHistoryComponent(history, liveEntry, autoPath, tui, theme, done),
      {
        overlay: true,
        overlayOptions: { maxHeight: "90%", minWidth: 60, anchor: "top-center" },
      },
    );

    if (result === "write-auto") {
      try {
        await writeHistoryFile(autoPath, ctx.cwd, history, sessionName ?? undefined);
        ctx.ui.notify(`Saved → ${nodePath.resolve(ctx.cwd, autoPath)}`, "info");
      } catch (err) {
        ctx.ui.notify(`Write failed: ${(err as Error).message}`, "error");
      }
    } else if (result === "write-custom") {
      const input = await ctx.ui.input(
        "Save timer history — path relative to the project directory",
        autoPath,
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
        await writeHistoryFile(rel, ctx.cwd, history, sessionName ?? undefined);
        ctx.ui.notify(`Saved → ${resolved}`, "info");
      } catch (err) {
        ctx.ui.notify(`Write failed: ${(err as Error).message}`, "error");
      }
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
  pi.on("message_end", async (event) => {
    if (event.message.role === "assistant") {
      lastProviderResponseAt = Date.now();
    }
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
    pendingPromptText = "";
    pendingInputAt = null;
    uiPromptActive = false;

    // Restore the cache anchor from the transcript so /reload (which preserves
    // context, hence the live prompt cache) keeps the cache-TTL clock ticking.
    // A genuinely new session has no turns, so the footer stays empty (—).
    const turns = reconstructHistory(ctx.sessionManager.getEntries());
    const lastTurn = turns[turns.length - 1];
    if (lastTurn) {
      lastProviderResponseAt = lastTurn.at + lastTurn.durationMs;
      lastRunMs = lastTurn.durationMs;
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
