import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Entity, type EntityTemplate } from "../api/client";
import { TemplateForm } from "./TemplateForm";

const apiMocks = vi.hoisted(() => ({
  createEdge: vi.fn(),
  createEntity: vi.fn(),
  getPrinters: vi.fn(),
  listEntities: vi.fn(),
  uploadArtifact: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createEdge: apiMocks.createEdge,
    createEntity: apiMocks.createEntity,
    getPrinters: apiMocks.getPrinters,
    listEntities: apiMocks.listEntities,
    uploadArtifact: apiMocks.uploadArtifact,
  };
});

const experimentTemplate: EntityTemplate = {
  name: "Experiment",
  entity_type: "note",
  fields: [
    { name: "sample", label: "Sample or Device", type: "entity" },
    { name: "name", label: "Log Title", type: "text", required: true },
  ],
  body: true,
};

const equipmentTemplate: EntityTemplate = {
  name: "Fab Equipment",
  entity_type: "instrument",
  defaults: { category: "fab" },
  fields: [
    { name: "name", label: "Common Name", type: "text", required: true },
  ],
  body: false,
  attachments: true,
};

function entity(overrides: Partial<Entity>): Entity {
  return {
    id: "01900000-0000-7000-8000-000000000100",
    accession: "N-2026-0100",
    entity_type: "note",
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

const createdNote = entity({ name: "Cooldown 18 log" });

const olderDevice = entity({
  id: "01900000-0000-7000-8000-000000000201",
  accession: "DEV-2026-0001",
  entity_type: "device",
  name: "C1",
  created_at: "2026-07-01T10:00:00Z",
});

const newerWafer = entity({
  id: "01900000-0000-7000-8000-000000000202",
  accession: "W-2026-0002",
  entity_type: "wafer",
  name: "W20260712-2",
  created_at: "2026-07-12T10:00:00Z",
});

beforeEach(() => {
  apiMocks.createEdge.mockReset().mockResolvedValue({});
  apiMocks.createEntity.mockReset().mockResolvedValue(createdNote);
  apiMocks.getPrinters.mockReset().mockResolvedValue([]);
  apiMocks.uploadArtifact
    .mockReset()
    .mockResolvedValue(
      entity({ entity_type: "artifact", accession: "ART-2026-0001" }),
    );
  apiMocks.listEntities
    .mockReset()
    .mockImplementation((entityType: string) =>
      Promise.resolve(
        entityType === "device"
          ? [olderDevice]
          : entityType === "wafer"
            ? [newerWafer]
            : [],
      ),
    );
});

afterEach(cleanup);

// Safari empties the input's FileList object in place when a handler clears
// the input's value (WebKit FileInputType::setValue); jsdom does not. Emulate
// it so a handler that reads the list lazily sees it empty, as on an iPhone.
function safariPick(input: HTMLElement, files: File[]): void {
  const live = [...files];
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => live,
  });
  Object.defineProperty(input, "value", {
    configurable: true,
    get: () => (live.length > 0 ? live[0].name : ""),
    set: () => {
      live.length = 0;
    },
  });
  fireEvent.change(input);
}

describe("Experiment sample dropdown", () => {
  it("lists recent samples and devices newest first and links the pick", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={experimentTemplate} />);

    const dropdown = (await screen.findByLabelText(
      "Sample or Device",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(dropdown.options.length).toBe(3);
    });
    expect(apiMocks.listEntities).toHaveBeenCalledWith("device", {
      limit: 100,
      order: "desc",
    });
    // Newest entity first regardless of which type it came from, listed by
    // name — the accession is identity, not what people pick by.
    expect(dropdown.options[1].textContent).toContain(newerWafer.name);
    expect(dropdown.options[1].textContent).not.toContain("W-2026-0002");
    expect(dropdown.options[2].textContent).toContain(olderDevice.name);

    await user.selectOptions(dropdown, newerWafer.id);
    await user.type(screen.getByLabelText(/Log Title/), "Cooldown 18 log");
    await user.click(screen.getByRole("button", { name: "Create experiment" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("note", {
        source_key: expect.stringMatching(/^web:/),
        name: "Cooldown 18 log",
        body: "",
        template: "Experiment",
        links: [{ relation: "refers_to", dst_id: newerWafer.id }],
      });
    });
    expect(apiMocks.createEdge).not.toHaveBeenCalled();
  });
});

describe("TemplateForm attachments", () => {
  it("uploads dropped files linked to the created record", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={experimentTemplate} />);

    const file = new File(["spectrum"], "s21.png", { type: "image/png" });
    const dropzone = screen.getByText("Drop files here, or").parentElement;
    fireEvent.drop(dropzone as HTMLElement, {
      dataTransfer: { files: [file] },
    });

    expect(await screen.findByText("s21.png")).toBeDefined();

    await user.type(screen.getByLabelText(/Log Title/), "Cooldown 18 log");
    await user.click(screen.getByRole("button", { name: "Create experiment" }));

    await waitFor(() => {
      expect(apiMocks.uploadArtifact).toHaveBeenCalledWith(file, {
        linkEntityId: createdNote.id,
      });
    });
  });

  it("uploads a machine photo for a bodyless equipment template", async () => {
    const createdInstrument = entity({
      id: "01900000-0000-7000-8000-000000000300",
      accession: "INST-2026-0005",
      entity_type: "instrument",
      name: "AJA Sputter",
    });
    apiMocks.createEntity.mockResolvedValue(createdInstrument);
    const user = userEvent.setup();
    render(<TemplateForm template={equipmentTemplate} />);

    const photo = new File(["jpeg"], "aja-sputter.jpg", {
      type: "image/jpeg",
    });
    await user.upload(screen.getByLabelText("Add attachments"), photo);
    await user.type(screen.getByLabelText(/Common Name/), "AJA Sputter");
    await user.click(
      screen.getByRole("button", { name: "Create fab equipment" }),
    );

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("instrument", {
        source_key: expect.stringMatching(/^web:/),
        category: "fab",
        name: "AJA Sputter",
      });
      expect(apiMocks.uploadArtifact).toHaveBeenCalledWith(photo, {
        linkEntityId: createdInstrument.id,
      });
    });
  });

  it("attaches a camera capture and uploads it with the record", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={experimentTemplate} />);

    const cameraInput = screen.getByLabelText("Take a photo");
    // The capture attribute is what sends mobile browsers straight to the
    // camera instead of the file picker.
    expect(cameraInput.getAttribute("capture")).toBe("environment");
    expect(cameraInput.getAttribute("accept")).toBe("image/*");

    const shot = new File(["jpeg"], "step-photo.jpg", { type: "image/jpeg" });
    await user.upload(cameraInput as HTMLInputElement, shot);
    expect(await screen.findByText("step-photo.jpg")).toBeDefined();

    await user.type(screen.getByLabelText(/Log Title/), "Hf sputter run");
    await user.click(screen.getByRole("button", { name: "Create experiment" }));

    await waitFor(() => {
      expect(apiMocks.uploadArtifact).toHaveBeenCalledWith(shot, {
        linkEntityId: createdNote.id,
      });
    });
  });

  it("keeps a photo and a file picked after typing on Safari", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={experimentTemplate} />);

    await user.type(screen.getByLabelText(/Log Title/), "Hf sputter run");
    const shot = new File(["jpeg"], "IMG_9204.jpeg", { type: "image/jpeg" });
    const data = new File(["txt"], "W-2026-0006_M1.txt", {
      type: "text/plain",
    });
    safariPick(screen.getByLabelText("Take a photo"), [shot]);
    safariPick(screen.getByLabelText("Add attachments"), [data]);
    await user.click(screen.getByRole("button", { name: "Create experiment" }));

    await waitFor(() => {
      expect(apiMocks.uploadArtifact).toHaveBeenCalledWith(shot, {
        linkEntityId: createdNote.id,
      });
      expect(apiMocks.uploadArtifact).toHaveBeenCalledWith(data, {
        linkEntityId: createdNote.id,
      });
    });
  });

  it("keeps failed uploads for retry without recreating the record", async () => {
    apiMocks.uploadArtifact.mockRejectedValueOnce(new Error("network down"));
    const user = userEvent.setup();
    render(<TemplateForm template={experimentTemplate} />);

    const file = new File(["data"], "sweep.h5", {
      type: "application/x-hdf5",
    });
    await user.upload(screen.getByLabelText("Add attachments"), file);
    await user.type(screen.getByLabelText(/Log Title/), "Cooldown 18 log");
    await user.click(screen.getByRole("button", { name: "Create experiment" }));

    expect(
      await screen.findByRole("button", { name: "Retry attachments" }),
    ).toBeDefined();
    expect(apiMocks.createEntity).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Retry attachments" }));

    await waitFor(() => {
      expect(apiMocks.uploadArtifact).toHaveBeenCalledTimes(2);
    });
    expect(apiMocks.createEntity).toHaveBeenCalledTimes(1);
  });
});
