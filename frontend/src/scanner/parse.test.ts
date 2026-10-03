import { describe, expect, it } from "vitest";

import { parseAccession } from "./parse";

describe("parseAccession", () => {
  it.each([
    ["W-2026-0001", "W-2026-0001"],
    ["  DEV-2026-0417  ", "DEV-2026-0417"],
    ["INST-1999-9999", "INST-1999-9999"],
    ["https://autolab.example/e/W-2026-0001", "W-2026-0001"],
    ["http://127.0.0.1:8000/e/DEV-2026-0417", "DEV-2026-0417"],
    ["https://another.example/e/CD-2026-0003?from=qr#record", "CD-2026-0003"],
    ["https://another.example/e/%44EV-2026-0417", "DEV-2026-0417"],
    ["/e/INST-2026-0008", "INST-2026-0008"],
    ["/e/INST-2026-0008/", "INST-2026-0008"],
  ])("parses %s", (input, expected) => {
    expect(parseAccession(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "dev-2026-0417",
    "DEV-26-0417",
    "DEV-2026-417",
    "DEV_2026_0417",
    "DEV-2026-0417-extra",
    "https://autolab.example/entity/DEV-2026-0417",
    "https://autolab.example/lab/e/DEV-2026-0417",
    "https://autolab.example/e/DEV-2026-0417/extra",
    "ftp://autolab.example/e/DEV-2026-0417",
    "/e/DEV%2F2026-0417",
    "/queue",
    "not an accession",
  ])("rejects %s", (input) => {
    expect(parseAccession(input)).toBeNull();
  });
});
