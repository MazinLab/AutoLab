import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import templates from "../../../app/data/templates.json";
import { type Entity, type EntityTemplate, type Layout } from "../api/client";
import { defaultLayout } from "../pages/setup/rfLayout";
import { TemplateForm, resetDropdownOptionsCache } from "./TemplateForm";

const apiMocks = vi.hoisted(() => ({
  createEntity: vi.fn(),
  getEntity: vi.fn(),
  getLineageGraph: vi.fn(),
  getPrinters: vi.fn(),
  getSetupLayout: vi.fn(),
  listAllEntities: vi.fn(),
  listEntities: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, ...apiMocks };
});

const setupTemplate = (templates as EntityTemplate[]).find((t) => t.name === "Experiment Setup")!;

function entity(overrides: Partial<Entity>): Entity {
  return {
    id: "x",
    accession: "X-2026-0001",
    entity_type: "wafer",
    name: "",
    description: "",
    extra: {},
    source_key: null,
    created_by_id: null,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    version: 0,
    ...overrides,
  };
}

const project = entity({ id: "project-1", accession: "PRJ-2026-0001", entity_type: "project", name: "Air Bridge", status: "active" });
const fridge = entity({
  id: "fridge-1",
  accession: "INST-2026-0001",
  entity_type: "instrument",
  name: "Blue Fridge",
  category: "testbed",
  kind: "dilution_refrigerator",
  extra: { base_temp_mk: 60 },
  default_layout: {},
});
const previousLayout: Layout = { ...defaultLayout("dilution_refrigerator", 0.06), notes: "previous" };
const previous = entity({
  id: "setup-9",
  accession: "ES-2026-0009",
  entity_type: "experiment_setup",
  name: "Cooldown 9",
  started_at: "2026-08-01T10:00:00Z",
  layout: previousLayout,
});

beforeEach(() => {
  resetDropdownOptionsCache();
  apiMocks.createEntity.mockReset().mockResolvedValue(entity({ id: "new", entity_type: "experiment_setup" }));
  apiMocks.getPrinters.mockReset().mockResolvedValue([]);
  apiMocks.listAllEntities.mockReset().mockResolvedValue([project]);
  apiMocks.listEntities.mockReset().mockImplementation((type: string) =>
    Promise.resolve(type === "instrument" ? [fridge] : []),
  );
  apiMocks.getEntity.mockReset().mockImplementation((_type: string, id: string) =>
    Promise.resolve({ data: id === "fridge-1" ? fridge : previous, etag: null }),
  );
  apiMocks.getLineageGraph.mockReset().mockResolvedValue({
    nodes: [{ id: "setup-9", entity_type: "experiment_setup", accession: "ES-2026-0009", depth: 1, name: "Cooldown 9" }],
    edges: [{ src_id: "setup-9", relation: "performed_on", dst_id: "fridge-1" }],
  });
  apiMocks.getSetupLayout.mockReset().mockResolvedValue({
    data: { layout: previousLayout, evaluation: null, saved_evaluation: null },
    etag: null,
  });
});

afterEach(() => {
  cleanup();
});

async function fillRequired(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const projectSelect = (await screen.findByLabelText("Project *")) as HTMLSelectElement;
  await waitFor(() => expect(projectSelect.disabled).toBe(false));
  await user.selectOptions(projectSelect, project.id);
  await user.type(screen.getByLabelText("Setup Title *"), "Cooldown 10");
  await user.type(screen.getByLabelText(/Started At/), "2026-09-09T10:00");
}

describe("Experiment Setup start from", () => {
  it("lists the default and previous setups once a testbed is picked, and seeds the layout", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={setupTemplate} />);
    expect(screen.queryByLabelText("Start from")).toBeNull();
    const instrument = (await screen.findByLabelText("Instrument *")) as HTMLSelectElement;
    await waitFor(() => expect(instrument.options.length).toBe(2));
    await user.selectOptions(instrument, fridge.id);
    const startFrom = (await screen.findByLabelText("Start from")) as HTMLSelectElement;
    await waitFor(() => expect(startFrom.options.length).toBe(2));
    expect(startFrom.options[1].textContent).toContain("Cooldown 9");
    await fillRequired(user);
    await user.type(screen.getByLabelText(/Base Temperature/), "13");
    await user.click(screen.getByRole("button", { name: "Create experiment setup" }));
    await waitFor(() => expect(apiMocks.createEntity).toHaveBeenCalledOnce());
    const payload = apiMocks.createEntity.mock.calls[0][1] as { layout: Layout; base_temp_mk: number };
    expect(payload.base_temp_mk).toBe(13);
    // Built in dilution default with the coldest stage at the form's 13 mK.
    expect(payload.layout.stages.map((s) => s.id)).toEqual(["rt", "50k", "4k", "still", "mxc"]);
    expect(payload.layout.stages[4]).toEqual({ id: "mxc", label: "13 mK", temp_k: 0.013 });
  });

  it("starts from a previous setup's layout when chosen", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={setupTemplate} />);
    const instrument = (await screen.findByLabelText("Instrument *")) as HTMLSelectElement;
    await waitFor(() => expect(instrument.options.length).toBe(2));
    await user.selectOptions(instrument, fridge.id);
    const startFrom = (await screen.findByLabelText("Start from")) as HTMLSelectElement;
    await waitFor(() => expect(startFrom.options.length).toBe(2));
    await user.selectOptions(startFrom, "setup:setup-9");
    await waitFor(() => expect(apiMocks.getSetupLayout).toHaveBeenCalledWith("setup-9"));
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Create experiment setup" }));
    await waitFor(() => expect(apiMocks.createEntity).toHaveBeenCalledOnce());
    const payload = apiMocks.createEntity.mock.calls[0][1] as { layout: Layout };
    expect(payload.layout.notes).toBe("previous");
    // No base temperature typed: the previous layout's 60 mK stays.
    expect(payload.layout.stages[4].temp_k).toBe(0.06);
  });

  it("keeps a cloned layout selected even after the default loads", async () => {
    const user = userEvent.setup();
    render(
      <TemplateForm
        initialEntityRefs={{ instrument: fridge }}
        initialLayout={{ layout: { ...previousLayout, notes: "clone" }, sourceAccession: "ES-2026-0009" }}
        template={setupTemplate}
      />,
    );
    const startFrom = (await screen.findByLabelText("Start from")) as HTMLSelectElement;
    await waitFor(() => expect(startFrom.options.length).toBe(3));
    expect(startFrom.value).toBe("clone");
    expect(startFrom.options[0].textContent).toBe("Cloned from ES-2026-0009");
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Create experiment setup" }));
    await waitFor(() => expect(apiMocks.createEntity).toHaveBeenCalledOnce());
    expect((apiMocks.createEntity.mock.calls[0][1] as { layout: Layout }).layout.notes).toBe("clone");
  });
});
