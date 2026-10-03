import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACTOR_STORAGE_KEY,
  type Entity,
  type EntityTemplate,
} from "../api/client";
import { PERSON_CREATED_EVENT } from "../components/ActorPicker";
import { TemplateForm } from "../components/TemplateForm";
import { NewEntityPage } from "./new";

const apiMocks = vi.hoisted(() => ({
  createEdge: vi.fn(),
  createEntity: vi.fn(),
  getEntity: vi.fn(),
  getLineageGraph: vi.fn(),
  getPrinters: vi.fn(),
  getRegistry: vi.fn(),
  getTemplates: vi.fn(),
  listEntities: vi.fn(),
  printLabel: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createEdge: apiMocks.createEdge,
    createEntity: apiMocks.createEntity,
    getEntity: apiMocks.getEntity,
    getLineageGraph: apiMocks.getLineageGraph,
    getPrinters: apiMocks.getPrinters,
    getRegistry: apiMocks.getRegistry,
    getTemplates: apiMocks.getTemplates,
    listEntities: apiMocks.listEntities,
    printLabel: apiMocks.printLabel,
  };
});

const groupedTemplates: EntityTemplate[] = [
  {
    name: "Wafer",
    entity_type: "wafer",
    group: "fab",
    fields: [
      { name: "name", label: "Wafer Name", type: "text", required: true },
    ],
    body: false,
  },
  {
    name: "Fab Recipe",
    entity_type: "fab_recipe",
    group: "fab",
    fields: [
      { name: "name", label: "Recipe Name", type: "text", required: true },
    ],
    body: true,
  },
  {
    name: "Experiment",
    entity_type: "note",
    group: "testing",
    fields: [
      { name: "name", label: "Log Title", type: "text", required: true },
    ],
    body: true,
  },
  {
    name: "Person",
    entity_type: "person",
    group: "other",
    fields: [
      { name: "name", label: "Full Name", type: "text", required: true },
      { name: "email", label: "Email", type: "text" },
    ],
    body: false,
  },
];

const waferTemplate: EntityTemplate = {
  name: "Wafer",
  entity_type: "wafer",
  group: "fab",
  fields: [
    { name: "name", label: "Wafer Name", type: "text", required: true },
    { name: "design", label: "Design", type: "entity" },
    { name: "material", label: "Material", type: "text" },
    { name: "diameter_mm", label: "Diameter", type: "number", unit: "mm" },
  ],
  body: false,
};

function entity(overrides: Partial<Entity>): Entity {
  return {
    id: "01900000-0000-7000-8000-000000000080",
    accession: "W-2026-0009",
    entity_type: "wafer",
    name: "",
    description: "",
    extra: {},
    source_key: null,
    created_by_id: null,
    created_at: "2026-07-20T10:00:00Z",
    updated_at: "2026-07-20T10:00:00Z",
    version: 0,
    ...overrides,
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
  apiMocks.createEdge.mockReset().mockResolvedValue({});
  apiMocks.createEntity.mockReset();
  apiMocks.getEntity.mockReset();
  apiMocks.getLineageGraph
    .mockReset()
    .mockResolvedValue({ nodes: [], edges: [] });
  apiMocks.getPrinters.mockReset().mockResolvedValue([]);
  apiMocks.getRegistry.mockReset();
  apiMocks.getTemplates.mockReset().mockResolvedValue(groupedTemplates);
  apiMocks.listEntities.mockReset().mockResolvedValue([]);
});

afterEach(cleanup);

describe("NewEntityPage grouped chooser", () => {
  it("splits templates into themed fab and testing columns", async () => {
    render(
      <MemoryRouter>
        <NewEntityPage />
      </MemoryRouter>,
    );

    const fabGroup = (
      await screen.findByRole("heading", { name: "Fab" })
    ).closest("section") as HTMLElement;
    const testingGroup = screen
      .getByRole("heading", { name: "Testing" })
      .closest("section") as HTMLElement;

    expect(fabGroup.className).toContain("template-group--fab");
    expect(testingGroup.className).toContain("template-group--testing");
    expect(
      within(fabGroup).getByRole("button", { name: "Wafer" }),
    ).toBeDefined();
    expect(
      within(fabGroup).getByRole("button", { name: "Fab Recipe" }),
    ).toBeDefined();
    expect(
      within(testingGroup).getByRole("button", { name: "Experiment" }),
    ).toBeDefined();
    expect(
      within(fabGroup).queryByRole("button", { name: "Experiment" }),
    ).toBeNull();
  });
});

describe("Person deep link", () => {
  it("preselects the template and adopts the created person as the actor", async () => {
    const person = entity({
      id: "01900000-0000-7000-8000-000000000090",
      accession: "P-2026-0002",
      entity_type: "person",
      name: "New Grad",
    });
    apiMocks.createEntity.mockResolvedValue(person);
    const personCreated = vi.fn();
    window.addEventListener(PERSON_CREATED_EVENT, personCreated);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/new?template=Person&actor=1"]}>
        <NewEntityPage />
      </MemoryRouter>,
    );

    await user.type(await screen.findByLabelText(/Full Name/), "New Grad");
    await user.click(screen.getByRole("button", { name: "Create person" }));

    await waitFor(() => {
      expect(window.localStorage.getItem(ACTOR_STORAGE_KEY)).toBe(person.id);
    });
    expect(personCreated).toHaveBeenCalledTimes(1);
    window.removeEventListener(PERSON_CREATED_EVENT, personCreated);
  });
});

describe("Sticky create another", () => {
  it("keeps the previous field values after success; Start blank resets", async () => {
    const person = entity({
      id: "01900000-0000-7000-8000-000000000095",
      accession: "P-2026-0003",
      entity_type: "person",
      name: "New Grad",
    });
    apiMocks.createEntity.mockResolvedValue(person);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/new"]}>
        <NewEntityPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole("button", { name: "Person" }));
    await user.type(screen.getByLabelText(/Full Name/), "New Grad");
    await user.type(screen.getByLabelText(/Email/), "grad@ucsb.edu");
    await user.click(screen.getByRole("button", { name: "Create person" }));

    expect(await screen.findByText("Created P-2026-0003")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Create another" }));

    // The form kept its values so a sibling record only needs a name tweak.
    expect((screen.getByLabelText(/Full Name/) as HTMLInputElement).value).toBe(
      "New Grad",
    );
    expect((screen.getByLabelText(/Email/) as HTMLInputElement).value).toBe(
      "grad@ucsb.edu",
    );

    await user.click(screen.getByRole("button", { name: "Create person" }));
    expect(await screen.findByText("Created P-2026-0003")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Start blank" }));

    expect((screen.getByLabelText(/Full Name/) as HTMLInputElement).value).toBe(
      "",
    );
  });
});

describe("Create feedback and log records", () => {
  it("says the automatic label went to the printer", async () => {
    apiMocks.createEntity.mockResolvedValue(
      entity({ accession: "W-2026-0006", name: "W6" }),
    );
    apiMocks.getPrinters.mockResolvedValue(["zebra"]);
    apiMocks.printLabel.mockResolvedValue({ printer: "zebra", format: "qr" });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/new"]}>
        <NewEntityPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole("button", { name: "Wafer" }));
    await user.type(screen.getByLabelText(/Wafer Name/), "W6");
    await user.click(screen.getByRole("button", { name: "Create wafer" }));

    expect(await screen.findByText("Label sent to zebra.")).toBeDefined();
  });

  it("starts a log record's Create another without the old title and log", async () => {
    apiMocks.createEntity.mockResolvedValue(
      entity({ accession: "NOTE-2026-0007", entity_type: "note" }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/new"]}>
        <NewEntityPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole("button", { name: "Experiment" }));
    await user.type(screen.getByLabelText(/Log Title/), "G4 initial");
    await user.click(screen.getByRole("button", { name: "Create experiment" }));
    expect(await screen.findByText("Created NOTE-2026-0007")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Create another" }));

    expect((screen.getByLabelText(/Log Title/) as HTMLInputElement).value).toBe(
      "",
    );
  });
});

describe("Clone and supersede prefill", () => {
  const sourceWafer = entity({
    id: "01900000-0000-7000-8000-000000000096",
    accession: "W-2026-0042",
    entity_type: "wafer",
    name: "W20260808-4",
  });

  function mockSourceFetch(): void {
    apiMocks.getRegistry.mockResolvedValue({
      id: sourceWafer.id,
      entity_type: "wafer",
      accession: sourceWafer.accession,
      source_key: null,
      version: 0,
      created_at: sourceWafer.created_at,
      updated_at: sourceWafer.updated_at,
      created_by_id: null,
    });
    apiMocks.getEntity.mockResolvedValue({ data: sourceWafer, etag: '"v0"' });
  }

  it("preselects the matching template and prefills values from ?from=", async () => {
    mockSourceFetch();
    render(
      <MemoryRouter initialEntries={[`/new?from=${sourceWafer.id}`]}>
        <NewEntityPage />
      </MemoryRouter>,
    );

    const nameInput = (await screen.findByLabelText(
      /Wafer Name/,
    )) as HTMLInputElement;
    expect(apiMocks.getRegistry).toHaveBeenCalledWith(sourceWafer.id);
    expect(apiMocks.getEntity).toHaveBeenCalledWith("wafer", sourceWafer.id);
    expect(nameInput.value).toBe("W20260808-4 (copy)");
  });

  it("restores entity references from the source's edges (Autolab-8oc)", async () => {
    const sourceDevice = entity({
      id: "01900000-0000-7000-8000-000000000095",
      accession: "DEV-2026-0007",
      entity_type: "device",
      name: "MKID-7",
    });
    const parentWafer = entity({
      id: "01900000-0000-7000-8000-000000000094",
      accession: "W-2026-0011",
      entity_type: "wafer",
      name: "NbTiN-11",
    });
    apiMocks.getTemplates.mockResolvedValue([
      {
        name: "Device",
        entity_type: "device",
        group: "fab",
        fields: [
          { name: "name", label: "Device Name", type: "text", required: true },
          {
            name: "wafer",
            label: "Source Wafer",
            type: "entity",
            required: true,
          },
        ],
        body: false,
      },
    ]);
    apiMocks.getRegistry.mockResolvedValue({
      id: sourceDevice.id,
      entity_type: "device",
      accession: sourceDevice.accession,
      source_key: null,
      version: 0,
      created_at: sourceDevice.created_at,
      updated_at: sourceDevice.updated_at,
      created_by_id: null,
    });
    apiMocks.getEntity.mockResolvedValue({ data: sourceDevice, etag: '"v0"' });
    apiMocks.getLineageGraph.mockResolvedValue({
      nodes: [
        {
          id: parentWafer.id,
          entity_type: "wafer",
          accession: parentWafer.accession,
          depth: 1,
          name: parentWafer.name,
        },
      ],
      edges: [
        {
          src_id: sourceDevice.id,
          dst_id: parentWafer.id,
          relation: "derived_from",
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={[`/new?from=${sourceDevice.id}`]}>
        <NewEntityPage />
      </MemoryRouter>,
    );

    const waferSelect = (await screen.findByRole("combobox", {
      name: /Source Wafer/,
    })) as HTMLSelectElement;
    await waitFor(() => {
      expect(waferSelect.value).toBe(parentWafer.id);
    });
    expect(apiMocks.getLineageGraph).toHaveBeenCalledWith(
      sourceDevice.id,
      expect.objectContaining({ direction: "up", depth: 1, hydrate: true }),
    );
  });

  it("adds a supersedes link and banner for ?supersede=", async () => {
    mockSourceFetch();
    const createdWafer = entity({
      id: "01900000-0000-7000-8000-000000000097",
      accession: "W-2026-0043",
      entity_type: "wafer",
      name: "W20260808-4 (copy)",
    });
    apiMocks.createEntity.mockResolvedValue(createdWafer);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[`/new?supersede=${sourceWafer.id}`]}>
        <NewEntityPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(`Will supersede ${sourceWafer.accession}`),
    ).toBeDefined();
    await screen.findByLabelText(/Wafer Name/);
    await user.click(screen.getByRole("button", { name: "Create wafer" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("wafer", {
        source_key: expect.stringMatching(/^web:/),
        name: "W20260808-4 (copy)",
        links: [{ relation: "supersedes", dst_id: sourceWafer.id }],
      });
    });
  });
});

describe("Clone template and extra-field fidelity", () => {
  // Two instrument templates whose only difference is the stamped category
  // default: the clone must pick the one matching the source record, not the
  // first entity_type match (which would silently flip the category).
  const instrumentTemplates: EntityTemplate[] = [
    {
      name: "Fab Equipment",
      entity_type: "instrument",
      group: "fab",
      defaults: { category: "fab" },
      fields: [
        { name: "name", label: "Common Name", type: "text", required: true },
        { name: "location", label: "Location", type: "text" },
      ],
      body: false,
    },
    {
      name: "Experimental Equipment",
      entity_type: "instrument",
      group: "testing",
      defaults: { category: "experimental" },
      fields: [
        { name: "name", label: "Common Name", type: "text", required: true },
        { name: "location", label: "Location", type: "text" },
      ],
      body: false,
    },
  ];

  it("clones an experimental instrument keeping its category and extra fields", async () => {
    apiMocks.getTemplates.mockResolvedValue(instrumentTemplates);
    const fridge = entity({
      id: "01900000-0000-7000-8000-0000000000a1",
      accession: "INST-2026-0001",
      entity_type: "instrument",
      name: "White Fridge",
      category: "experimental",
      // Flexible fields land in `extra` server-side; the clone must not
      // silently drop them.
      extra: { location: "B107" },
    });
    apiMocks.getRegistry.mockResolvedValue({
      id: fridge.id,
      entity_type: "instrument",
      accession: fridge.accession,
      source_key: null,
      version: 0,
      created_at: fridge.created_at,
      updated_at: fridge.updated_at,
      created_by_id: null,
    });
    apiMocks.getEntity.mockResolvedValue({ data: fridge, etag: '"v0"' });
    apiMocks.createEntity.mockResolvedValue(
      entity({
        id: "01900000-0000-7000-8000-0000000000a2",
        accession: "INST-2026-0002",
        entity_type: "instrument",
        name: "White Fridge (copy)",
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[`/new?from=${fridge.id}`]}>
        <NewEntityPage />
      </MemoryRouter>,
    );

    // The Experimental Equipment template was preferred over Fab Equipment.
    expect(
      await screen.findByRole("heading", { name: "Experimental Equipment" }),
    ).toBeDefined();
    expect(
      (screen.getByLabelText(/Common Name/) as HTMLInputElement).value,
    ).toBe("White Fridge (copy)");
    // The extra-stored location carried over into the visible field.
    expect((screen.getByLabelText(/Location/) as HTMLInputElement).value).toBe(
      "B107",
    );

    await user.click(
      screen.getByRole("button", { name: "Create experimental equipment" }),
    );
    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("instrument", {
        source_key: expect.stringMatching(/^web:/),
        category: "experimental",
        name: "White Fridge (copy)",
        location: "B107",
      });
    });
  });
});

describe("Analysis template", () => {
  const analysisTemplate: EntityTemplate = {
    name: "Analysis",
    entity_type: "analysis_run",
    group: "testing",
    fields: [
      { name: "name", label: "Analysis Title", type: "text", required: true },
      { name: "experiment", label: "Experiment", type: "entity" },
      { name: "software", label: "Analysis Software", type: "entity" },
    ],
    body: true,
  };

  it("filters the experiment dropdown and links experiment and software", async () => {
    const experimentNote = entity({
      id: "01900000-0000-7000-8000-000000000091",
      accession: "NOTE-2026-0101",
      entity_type: "note",
      name: "Dark sweep",
      template: "Experiment",
    });
    const fabNote = entity({
      id: "01900000-0000-7000-8000-000000000092",
      accession: "NOTE-2026-0102",
      entity_type: "note",
      name: "Etch drift",
      template: "Fab Note",
    });
    const software = entity({
      id: "01900000-0000-7000-8000-000000000093",
      accession: "SW-2026-0001",
      entity_type: "software",
      name: "mkidanalysis",
    });
    const createdAnalysis = entity({
      id: "01900000-0000-7000-8000-000000000094",
      accession: "AR-2026-0001",
      entity_type: "analysis_run",
      name: "Qi fits",
    });
    apiMocks.createEntity.mockResolvedValue(createdAnalysis);
    apiMocks.listEntities.mockImplementation((entityType: string) =>
      Promise.resolve(
        entityType === "note"
          ? [experimentNote, fabNote]
          : entityType === "software"
            ? [software]
            : [],
      ),
    );
    const user = userEvent.setup();
    render(<TemplateForm template={analysisTemplate} />);

    await user.type(screen.getByLabelText(/Analysis Title/), "Qi fits");
    const experimentDropdown = (await screen.findByLabelText(
      "Experiment",
    )) as HTMLSelectElement;
    // Fab notes are filtered out; only Experiment-template notes remain.
    await waitFor(() => {
      expect(experimentDropdown.options.length).toBe(2);
    });
    expect(
      [...experimentDropdown.options].some((option) =>
        option.textContent?.includes("Etch drift"),
      ),
    ).toBe(false);
    await user.selectOptions(experimentDropdown, experimentNote.id);
    await user.selectOptions(
      screen.getByLabelText("Analysis Software"),
      software.id,
    );
    await user.type(
      screen.getByLabelText("Markdown note"),
      "18/18 resonators fit.",
    );
    await user.click(screen.getByRole("button", { name: "Create analysis" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("analysis_run", {
        source_key: expect.stringMatching(/^web:/),
        name: "Qi fits",
        body: "18/18 resonators fit.",
        links: [
          { relation: "derived_from", dst_id: experimentNote.id },
          { relation: "refers_to", dst_id: software.id },
        ],
      });
    });
    expect(apiMocks.createEdge).not.toHaveBeenCalled();
  });
});

describe("Wafer template", () => {
  it("creates the wafer and links its design as structural ancestry", async () => {
    const design = entity({
      id: "01900000-0000-7000-8000-000000000081",
      accession: "DSN-2026-0001",
      entity_type: "design",
      name: "U1 trilayer",
    });
    const createdWafer = entity({ name: "W20260720-1" });
    apiMocks.createEntity.mockResolvedValue(createdWafer);
    apiMocks.listEntities.mockResolvedValue([design]);
    const user = userEvent.setup();
    render(<TemplateForm template={waferTemplate} />);

    await user.type(screen.getByLabelText(/Wafer Name/), "W20260720-1");
    const designDropdown = (await screen.findByLabelText(
      "Design",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(designDropdown.options.length).toBe(2);
    });
    await user.selectOptions(designDropdown, design.id);
    await user.type(screen.getByLabelText(/Material/), "Si");
    await user.type(screen.getByLabelText(/Diameter/), "100");
    await user.click(screen.getByRole("button", { name: "Create wafer" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("wafer", {
        source_key: expect.stringMatching(/^web:/),
        name: "W20260720-1",
        material: "Si",
        diameter_mm: 100,
        links: [{ relation: "derived_from", dst_id: design.id }],
      });
    });
    expect(apiMocks.createEdge).not.toHaveBeenCalled();
  });
});

describe("Add-step deep link (?for=)", () => {
  const wafer = entity({
    id: "01900000-0000-7000-8000-000000000097",
    accession: "W-2026-0050",
    entity_type: "wafer",
    name: "W20260812-1",
  });

  const fabStepTemplate: EntityTemplate = {
    name: "Fab Step",
    entity_type: "fab_step",
    group: "fab",
    fields: [
      { name: "wafer", label: "Wafer", type: "entity", required: true },
      { name: "recipe", label: "Recipe", type: "entity" },
      {
        name: "step_index",
        label: "Step Index",
        type: "number",
        required: true,
      },
    ],
    body: true,
  };

  it("preselects the wafer and suggests the next step index", async () => {
    apiMocks.getTemplates.mockResolvedValue([fabStepTemplate]);
    apiMocks.getRegistry.mockResolvedValue({
      id: wafer.id,
      entity_type: "wafer",
      accession: wafer.accession,
      source_key: null,
      version: 0,
      created_at: wafer.created_at,
      updated_at: wafer.updated_at,
      created_by_id: null,
    });
    const existingStep = entity({
      id: "01900000-0000-7000-8000-000000000098",
      accession: "STEP-2026-0004",
      entity_type: "fab_step",
      step_index: 4,
    });
    apiMocks.getEntity.mockImplementation(async (entityType: string) => ({
      data: entityType === "fab_step" ? existingStep : wafer,
      etag: '"v0"',
    }));
    // The wafer already carries one step, so the form should offer index 5.
    apiMocks.getLineageGraph.mockResolvedValue({
      nodes: [
        {
          id: existingStep.id,
          accession: existingStep.accession,
          entity_type: "fab_step",
          depth: 1,
        },
      ],
      edges: [],
    });

    render(
      <MemoryRouter initialEntries={[`/new?template=Fab+Step&for=${wafer.id}`]}>
        <NewEntityPage />
      </MemoryRouter>,
    );

    const waferPicker = (await screen.findByLabelText(
      /Wafer/,
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(waferPicker.value).toBe(wafer.id);
    });
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/Step Index/) as HTMLInputElement).value,
      ).toBe("5");
    });
  });

  it("still renders the form when the target record cannot be loaded", async () => {
    apiMocks.getTemplates.mockResolvedValue([fabStepTemplate]);
    apiMocks.getRegistry.mockRejectedValue(new Error("gone"));

    render(
      <MemoryRouter initialEntries={[`/new?template=Fab+Step&for=${wafer.id}`]}>
        <NewEntityPage />
      </MemoryRouter>,
    );

    const waferPicker = (await screen.findByLabelText(
      /Wafer/,
    )) as HTMLSelectElement;
    expect(waferPicker.value).toBe("");
  });
});
