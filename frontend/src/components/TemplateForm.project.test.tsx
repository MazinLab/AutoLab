import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import templates from "../../../app/data/templates.json";
import {
  type Entity,
  type EntityTemplate,
  type EntityType,
} from "../api/client";
import {
  TemplateForm,
  entityRefsForTarget,
  resetDropdownOptionsCache,
} from "./TemplateForm";

const apiMocks = vi.hoisted(() => ({
  createEntity: vi.fn(),
  getPrinters: vi.fn(),
  listAllEntities: vi.fn(),
  listEntities: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createEntity: apiMocks.createEntity,
    getPrinters: apiMocks.getPrinters,
    listAllEntities: apiMocks.listAllEntities,
    listEntities: apiMocks.listEntities,
  };
});

function entity(
  id: string,
  accession: string,
  entityType: EntityType,
  overrides: Partial<Entity> = {},
): Entity {
  return {
    id,
    accession,
    entity_type: entityType,
    name: accession,
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

function shipped(name: string): EntityTemplate {
  const template = (templates as EntityTemplate[]).find((t) => t.name === name);
  if (!template) {
    throw new Error(`The shipped ${name} template is missing.`);
  }
  return template;
}

const airBridge = entity("project-1", "PRJ-2026-0001", "project", {
  name: "Air Bridge MKIDs",
  status: "active",
});
const oldProject = entity("project-2", "PRJ-2026-0002", "project", {
  name: "Archived optics",
  status: "completed",
});
const parkedProject = entity("project-3", "PRJ-2026-0003", "project", {
  name: "Parked",
  status: "on_hold",
});
const wafer = entity("wafer-1", "W-2026-0001", "wafer", {
  name: "W1",
  project_id: airBridge.id,
});
const setup = entity("setup-1", "ES-2026-0001", "experiment_setup", {
  name: "Cooldown 4",
  project_id: parkedProject.id,
});

beforeEach(() => {
  resetDropdownOptionsCache();
  apiMocks.createEntity.mockReset().mockResolvedValue(
    entity("created-1", "X-2026-0001", "device"),
  );
  apiMocks.getPrinters.mockReset().mockResolvedValue([]);
  apiMocks.listAllEntities
    .mockReset()
    .mockResolvedValue([oldProject, airBridge, parkedProject]);
  apiMocks.listEntities.mockReset().mockImplementation((type: string) =>
    Promise.resolve(
      type === "wafer"
        ? [wafer]
        : type === "experiment_setup"
          ? [setup]
          : type === "device"
            ? [wafer]
            : [],
    ),
  );
});

afterEach(() => {
  cleanup();
});

async function projectSelect(label = "Project *"): Promise<HTMLSelectElement> {
  const select = (await screen.findByLabelText(label)) as HTMLSelectElement;
  await waitFor(() => expect(select.disabled).toBe(false));
  return select;
}

describe("project dropdown", () => {
  it("lists active projects first, on hold marked, completed in their own group", async () => {
    render(<TemplateForm template={shipped("Wafer")} />);
    const select = await projectSelect();
    const labels = Array.from(select.options).map((option) => option.textContent);
    expect(labels).toEqual([
      "Select project…",
      "Air Bridge MKIDs",
      "Parked (on hold)",
      "Archived optics",
    ]);
    const group = select.querySelector("optgroup");
    expect(group?.getAttribute("label")).toBe("Completed");
    expect(group?.textContent).toContain("Archived optics");
    expect(select.required).toBe(true);
  });

  it("is optional on a design and offers None", async () => {
    render(<TemplateForm template={shipped("Design")} />);
    const select = await projectSelect("Project");
    expect(select.required).toBe(false);
    expect(select.options[0].textContent).toBe("None");
  });

  it("submits the pick as the project_id column, not an edge", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={shipped("Wafer")} />);
    const select = await projectSelect();
    await user.selectOptions(select, airBridge.id);
    await user.type(screen.getByLabelText("Wafer Name *"), "W9");
    await user.click(screen.getByRole("button", { name: "Create wafer" }));
    await waitFor(() => expect(apiMocks.createEntity).toHaveBeenCalledOnce());
    const payload = apiMocks.createEntity.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.project_id).toBe(airBridge.id);
    expect(payload.links).toBeUndefined();
  });

  it("inherits the project from the picked wafer on the Device form", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={shipped("Device")} />);
    const select = await projectSelect();
    const waferSelect = (await screen.findByLabelText(
      "Source Wafer *",
    )) as HTMLSelectElement;
    await waitFor(() => expect(waferSelect.options.length).toBe(2));
    await user.selectOptions(waferSelect, wafer.id);
    await waitFor(() => expect(select.value).toBe(airBridge.id));
  });

  it("keeps an explicit choice when a later reference pick disagrees", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={shipped("Device")} />);
    const select = await projectSelect();
    await user.selectOptions(select, parkedProject.id);
    const waferSelect = (await screen.findByLabelText(
      "Source Wafer *",
    )) as HTMLSelectElement;
    await waitFor(() => expect(waferSelect.options.length).toBe(2));
    await user.selectOptions(waferSelect, wafer.id);
    // The wafer belongs to Air Bridge; the deliberate pick stands.
    expect(select.value).toBe(parkedProject.id);
  });

  it("treats an initial ref listed as explicit like a user choice", async () => {
    const user = userEvent.setup();
    render(
      <TemplateForm
        initialEntityRefs={{ project: parkedProject }}
        initialExplicitFields={["project"]}
        template={shipped("Device")}
      />,
    );
    const select = await projectSelect();
    expect(select.value).toBe(parkedProject.id);
    const waferSelect = (await screen.findByLabelText(
      "Source Wafer *",
    )) as HTMLSelectElement;
    await waitFor(() => expect(waferSelect.options.length).toBe(2));
    await user.selectOptions(waferSelect, wafer.id);
    expect(select.value).toBe(parkedProject.id);
  });

  it("shows a hint when sample and setup carry different projects", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={shipped("Experiment")} />);
    await projectSelect();
    const sampleSelect = (await screen.findByLabelText(
      "Sample or Device",
    )) as HTMLSelectElement;
    await waitFor(() => expect(sampleSelect.options.length).toBeGreaterThan(1));
    await user.selectOptions(sampleSelect, wafer.id);
    const setupSelect = (await screen.findByLabelText(
      "Experiment Setup",
    )) as HTMLSelectElement;
    await waitFor(() => expect(setupSelect.options.length).toBe(2));
    await user.selectOptions(setupSelect, setup.id);
    expect(
      await screen.findByText(
        "Sample or Device is in Air Bridge MKIDs; Experiment Setup is in Parked.",
      ),
    ).toBeTruthy();
    // Without an explicit choice the later pick wins.
    expect((screen.getByLabelText("Project *") as HTMLSelectElement).value).toBe(
      parkedProject.id,
    );
  });

  it("holds a prefilled id until the option list arrives", async () => {
    let resolveOptions: (rows: Entity[]) => void = () => {};
    apiMocks.listAllEntities.mockReturnValue(
      new Promise<Entity[]>((resolve) => {
        resolveOptions = resolve;
      }),
    );
    render(
      <TemplateForm
        initialEntityRefs={entityRefsForTarget(shipped("Device"), wafer)}
        template={shipped("Device")}
      />,
    );
    const select = (await screen.findByLabelText("Project *")) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe(airBridge.id);
    resolveOptions([airBridge]);
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe(airBridge.id);
    expect(select.selectedOptions[0].textContent).toBe("Air Bridge MKIDs");
  });
});

describe("select fields and the Testbed template", () => {
  it("submits a select field's value and the template defaults", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={shipped("Testbed")} />);
    await user.type(screen.getByLabelText("Common Name *"), "Blue Fridge");
    await user.selectOptions(screen.getByLabelText("Kind"), "dilution_refrigerator");
    await user.type(screen.getByLabelText(/Base Temperature/), "12");
    await user.click(screen.getByRole("button", { name: "Create testbed" }));
    await waitFor(() => expect(apiMocks.createEntity).toHaveBeenCalledOnce());
    expect(apiMocks.createEntity).toHaveBeenCalledWith(
      "instrument",
      expect.objectContaining({
        name: "Blue Fridge",
        category: "testbed",
        kind: "dilution_refrigerator",
        base_temp_mk: 12,
      }),
    );
  });

  it("starts a project's status at the select field default", async () => {
    render(<TemplateForm template={shipped("Project")} />);
    const status = (await screen.findByLabelText("Status")) as HTMLSelectElement;
    expect(status.value).toBe("active");
  });
});
