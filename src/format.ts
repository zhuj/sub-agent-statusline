/**
 * Shared number/duration/percent formatters used by both the TUI plugin and
 * status text formatting. Centralised to avoid drift between status text
 * (render.ts) and OpenTUI rendering (tui.tsx).
 */

/**
 * Formats an elapsed-milliseconds value as `MM:SS` or `HH:MM:SS`.
 * Negative values clamp to zero. `undefined` is treated as zero.
 */
export function formatDuration(elapsedMs: number | undefined): string {
  const totalSeconds = Math.max(0, Math.floor((elapsedMs ?? 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Formats a number with thousands separators using en-US locale. Negative
 * values clamp to zero. Non-finite values also clamp to zero.
 */
export function formatNumber(value: number): string {
  const rounded = Math.round(value);
  return Math.max(0, rounded).toLocaleString("en-US");
}

/**
 * Formats a token count with a singular/plural label, e.g. `1 token` /
 * `1,500 tokens`.
 */
export function formatTokenCount(total: number): string {
  const label = total === 1 ? "token" : "tokens";
  return `${formatNumber(total)} ${label}`;
}

/**
 * Formats a context-percent value with up to one decimal place, e.g.
 * `12.3% used` / `12% used`.
 */
export function formatPercentUsed(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 0.05) {
    return `${Math.round(rounded)}% used`;
  }
  return `${rounded.toFixed(1)}% used`;
}

/**
 * Formats a token total in compact form, e.g. `850 ctx`, `1.5k ctx`,
 * `2.3M ctx`. Used by the TUI sidebar where vertical space is scarce.
 */
export function formatCompactTokenCount(total: number): string {
  const value = Math.max(0, total);
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M ctx`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k ctx`;
  }
  return `${Math.round(value)} ctx`;
}

/**
 * Formats a context-percent value as an integer-with-suffix, e.g. `12%`.
 * Used by the TUI sidebar where vertical space is scarce.
 */
export function formatCompactPercentUsed(percent: number): string {
  const rounded = Math.round(percent);
  return `${Math.max(0, rounded)}%`;
}
