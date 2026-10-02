/** Small formatting helpers for console output. */

import { stripAnsi } from "../cli/terminalStyle";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 8650752 → "8.3 MB" */
export function formatBytes(byteCount: number): string {
  let value = byteCount;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = unitIndex === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${BYTE_UNITS[unitIndex]}`;
}

/** 0.873 → "87%" */
export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * Renders rows as left-aligned columns separated by two spaces.
 * Widths ignore ANSI color codes so colored cells still line up.
 */
export function renderTable(rows: string[][], indent = "  "): string {
  const columnWidths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, columnIndex) => {
      const visibleWidth = stripAnsi(cell).length;
      columnWidths[columnIndex] = Math.max(columnWidths[columnIndex] ?? 0, visibleWidth);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, columnIndex) => {
          const isLastColumn = columnIndex === row.length - 1;
          if (isLastColumn) return cell;
          const padding = (columnWidths[columnIndex] ?? 0) - stripAnsi(cell).length;
          return cell + " ".repeat(padding);
        })
        .join("  "),
    )
    .map((line) => indent + line)
    .join("\n");
}
