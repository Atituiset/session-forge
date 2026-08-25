export interface Column {
  header: string;
  width?: number;
  align?: "left" | "right";
}

export function renderTable(columns: Column[], rows: string[][]): string {
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...rows.map((r) => (r[i] ?? "").length), 0),
  );
  const line = widths.map((w) => "-".repeat(w + 2)).join("+");
  const fmt = (cell: string, col: Column, w: number): string => {
    const v = cell.length > w ? `${cell.slice(0, w - 1)}…` : cell;
    return col.align === "right" ? v.padStart(w) : v.padEnd(w);
  };
  const header = columns.map((c, i) => ` ${fmt(c.header, c, widths[i] ?? 0)} `).join("|");
  const body = rows
    .map((row) => columns.map((c, i) => ` ${fmt(row[i] ?? "", c, widths[i] ?? 0)} `).join("|"))
    .join("\n");
  return [line, header, line, body, line].join("\n");
}

export function bar(value: number, max: number, width = 24): string {
  if (max <= 0) return "";
  const filled = Math.max(1, Math.round((value / max) * width));
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}
