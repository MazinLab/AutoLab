import { describe, expect, it } from "vitest";

import type { ResultSummaryTable } from "../../api/client";
import { formatResultValue, tableToCsv } from "./resultsTable";

const table: ResultSummaryTable = {
  summary: { id: "rs", accession: "RS-2026-0001", name: "TLS", columns: [] },
  keys: ["q_i", "t_mk"],
  columns: [{ key: "q_i", label: "Qi" }, { key: "t_mk", label: "t_mk" }],
  rows: [
    {
      analysis: { id: "a", accession: "AR-2026-0001", name: "Fit, 1", created_at: "2026-09-01T10:00:00Z" },
      project: { id: "p", accession: "PROJ-2026-0001", name: "Alpha" },
      experiment: null,
      results: { q_i: 1234567, t_mk: 100 },
    },
  ],
};

describe("resultsTable helpers", () => {
  it("formats numbers to six significant digits and leaves strings", () => {
    expect(formatResultValue(1234567)).toBe("1.23457e+6");
    expect(formatResultValue(1500000)).toBe("1.5e+6");
    expect(formatResultValue(100)).toBe("100");
    expect(formatResultValue(3.2e-17)).toBe("3.2e-17");
    expect(formatResultValue(0.125)).toBe("0.125");
    expect(formatResultValue("Al/Ti")).toBe("Al/Ti");
    expect(formatResultValue(undefined)).toBe("");
  });

  it("writes CSV with leading context columns and quoted commas", () => {
    const csv = tableToCsv(table);
    expect(csv.split("\n")[0]).toBe("analysis,accession,project,experiment,date,Qi,t_mk");
    expect(csv.split("\n")[1]).toBe('"Fit, 1",AR-2026-0001,Alpha,,2026-09-01T10:00:00Z,1234567,100');
  });
});
