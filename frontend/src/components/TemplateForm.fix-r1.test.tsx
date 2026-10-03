import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import templates from "../../../app/data/templates.json";
import { type Entity, type EntityTemplate } from "../api/client";
import { TemplateForm, resetDropdownOptionsCache } from "./TemplateForm";

const apiMocks = vi.hoisted(() => ({
  createEntity: vi.fn(),
  getPrinters: vi.fn(),
  listEntities: vi.fn(),
  listAllEntities: vi.fn(),
  printLabel: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createEntity: apiMocks.createEntity,
    getPrinters: apiMocks.getPrinters,
    listEntities: apiMocks.listEntities,
    listAllEntities: apiMocks.listAllEntities,
    printLabel: apiMocks.printLabel,
  };
});

const airBridge: Entity = {
  id: "01900000-0000-7000-8000-000000000301",
  accession: "PRJ-2026-0001",
  entity_type: "project",
  name: "Air Bridge MKIDs",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-19T08:00:00Z",
  updated_at: "2026-07-19T08:00:00Z",
  version: 0,
  status: "active",
};

const createdExperiment: Entity = {
  id: "01900000-0000-7000-8000-000000000201",
  accession: "N-2026-0201",
  entity_type: "note",
  name: "Measure resonator response",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-19T08:00:00Z",
  updated_at: "2026-07-19T08:00:00Z",
  version: 0,
};

const experimentTemplate = templates.find(
  (template) => template.name === "Experiment",
) as EntityTemplate | undefined;

if (!experimentTemplate) {
  throw new Error("The shipped Experiment template is missing.");
}

beforeEach(() => {
  apiMocks.createEntity.mockReset();
  apiMocks.listEntities.mockReset().mockResolvedValue([]);
  resetDropdownOptionsCache();
  apiMocks.listAllEntities.mockReset().mockResolvedValue([airBridge]);
  apiMocks.getPrinters.mockReset().mockResolvedValue(["bench", "cleanroom"]);
  apiMocks.printLabel.mockReset().mockResolvedValue({
    printer: "cleanroom",
    format: "qr",
  });
});

afterEach(() => {
  cleanup();
});

describe("TemplateForm auto-print label guard", () => {
  it("does not auto-print for a non-labelable note template", async () => {
    apiMocks.createEntity.mockResolvedValue(createdExperiment);
    const user = userEvent.setup();
    render(<TemplateForm template={experimentTemplate} />);

    // The shipped template requires a project (spec 2026-09-09).
    const projectSelect = (await screen.findByLabelText(
      "Project *",
    )) as HTMLSelectElement;
    await waitFor(() => expect(projectSelect.disabled).toBe(false));
    await user.selectOptions(projectSelect, airBridge.id);
    await user.type(screen.getByLabelText("Log Title *"), "Sweep the feedline");
    await user.click(screen.getByRole("button", { name: "Create experiment" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledOnce();
    });
    // A note has no physical object to label: neither the printer probe nor the
    // print call may fire.
    expect(apiMocks.getPrinters).not.toHaveBeenCalled();
    expect(apiMocks.printLabel).not.toHaveBeenCalled();
  });
});
