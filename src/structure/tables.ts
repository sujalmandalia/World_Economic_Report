const VALUE = /^(-?[\d,]*\.?\d+[a-z]?|\.\.|-|n\.a\.)$/i;

const cellsOf = (line: string | undefined) => (line ?? "").split("\t").map((c) => c.trim()).filter(Boolean);
const isValueRow = (cells: string[]) => cells.length > 1 && cells.every((c) => VALUE.test(c));

const COLUMN_HEADER = /^(\d{4}[a-z]?|\d{2}Q\d[a-z]?|\(\d+\))$/;

export const isDataRow = (row: string[]) =>
  row.length > 1 && row.slice(1).every((c) => VALUE.test(c)) && !row.slice(1).every((c) => COLUMN_HEADER.test(c));

// Re-attaches wrapped row labels: "Latin America and the" / "2.3 2.3 ..." / "Caribbean" -> one row.
export function parseTableRows(lines: string[]): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const cells = cellsOf(lines[i]);
    if (cells.length === 0) continue;

    const values = cellsOf(lines[i + 1]);
    if (cells.length === 1 && isValueRow(values)) {
      let label = cells[0]!;
      const after = cellsOf(lines[i + 2]);
      const afterStartsNextRow = isValueRow(cellsOf(lines[i + 3]));
      if (after.length === 1 && !VALUE.test(after[0]!) && after[0]!.length < 40 && !afterStartsNextRow) {
        label = `${label} ${after[0]}`;
        i++;
      }
      rows.push([label, ...values]);
      i++;
      continue;
    }
    rows.push(cells);
  }
  return rows;
}
