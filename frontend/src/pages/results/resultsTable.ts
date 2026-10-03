import type { ResultSummaryTable, ResultValue } from "../../api/client";

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** Six significant digits, trailing zeros dropped; strings pass through. */
export function formatResultValue(value: ResultValue | undefined): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Number.isInteger(value) && Math.abs(value) < 1e6) {
    return String(value);
  }
  const text = value.toPrecision(6);
  if (text.includes("e")) {
    const [mantissa, exponent] = text.split("e");
    return `${trimZeros(mantissa)}e${exponent}`;
  }
  return trimZeros(text);
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Header: analysis,accession,project,experiment,date, then column labels. Values unformatted. */
export function tableToCsv(table: ResultSummaryTable): string {
  const header = [
    "analysis",
    "accession",
    "project",
    "experiment",
    "date",
    ...table.columns.map((column) => column.label),
  ];
  const lines = table.rows.map((row) =>
    [
      row.analysis.name,
      row.analysis.accession,
      row.project?.name ?? "",
      row.experiment?.name ?? "",
      row.analysis.created_at,
      ...table.columns.map((column) => row.results[column.key] ?? ""),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.map(csvCell).join(","), ...lines].join("\n");
}
