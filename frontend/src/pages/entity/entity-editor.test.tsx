import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type Entity } from "../../api/client";
import { EntityEditor, editableFields } from "./EntityEditor";

const apiMocks = vi.hoisted(() => ({
  getSchema: vi.fn(),
  patchEntity: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    getSchema: apiMocks.getSchema,
    patchEntity: apiMocks.patchEntity,
  };
});

const instrumentSchema = {
  properties: {
    id: { type: "string", format: "uuid" },
    name: { default: "", title: "Name", type: "string" },
    description: { default: "", title: "Description", type: "string" },
    extra: { additionalProperties: true, type: "object" },
    kind: { default: "", title: "Kind", type: "string" },
    category: { default: "", title: "Category", type: "string" },
    location: { default: "", title: "Location", type: "string" },
    base_temp_mk: {
      anyOf: [{ type: "number" }, { type: "null" }],
      default: null,
      title: "Base temp mk",
    },
  },
};

const noteSchema = {
  properties: {
    id: { type: "string", format: "uuid" },
    name: { default: "", title: "Name", type: "string" },
    description: { default: "", title: "Description", type: "string" },
    extra: { additionalProperties: true, type: "object" },
    body: { default: "", title: "Body", type: "string" },
    template: { default: "", title: "Template", type: "string" },
  },
};

const fridge: Entity = {
  id: "01900000-0000-7000-8000-000000000070",
  accession: "INST-2026-0001",
  entity_type: "instrument",
  name: "White Fridge",
  description: "",
  extra: {
    serial_number: "LD-400-17",
    channels: [1, 2],
    pumped: true,
    still_power_uw: 340,
  },
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-20T10:00:00Z",
  updated_at: "2026-07-20T10:00:00Z",
  version: 2,
  kind: "dilution fridge",
  category: "experimental",
  location: "Broida 2015",
};

const note: Entity = {
  ...fridge,
  id: "01900000-0000-7000-8000-000000000071",
  accession: "NOTE-2026-0001",
  entity_type: "note",
  name: "Cooldown 18",
  extra: {},
  body: "Base reached.",
  template: "Experiment",
};

beforeEach(() => {
  apiMocks.getSchema.mockReset().mockResolvedValue({
    entity_types: { instrument: instrumentSchema, note: noteSchema },
    relations: [],
  });
  apiMocks.patchEntity.mockReset().mockResolvedValue({
    data: fridge,
    etag: '"v3"',
  });
});

afterEach(cleanup);

describe("editableFields", () => {
  it("hides identity fields always and integrity fields for artifacts", () => {
    const properties = {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      extra: { type: "object" },
      uri: { type: "string" },
      checksum_sha256: { type: "string" },
      size_bytes: { anyOf: [{ type: "integer" }, { type: "null" }] },
      media_type: { type: "string" },
    };
    const artifactFields = editableFields("artifact", properties).map(
      (field) => field.name,
    );
    expect(artifactFields).toEqual(["name", "media_type"]);

    const otherFields = editableFields("wafer", properties).map(
      (field) => field.name,
    );
    expect(otherFields).toContain("uri");
  });
});

describe("EntityEditor", () => {
  it("saves only the changed fields with the loaded ETag", async () => {
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(
      <EntityEditor
        entity={fridge}
        etag={'"v2"'}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );

    const location = await screen.findByLabelText("Location");
    await user.clear(location);
    await user.type(location, "Broida 1015");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(apiMocks.patchEntity).toHaveBeenCalledWith(
        "instrument",
        fridge.id,
        { location: "Broida 1015" },
        '"v2"',
      );
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it("edits scalar extra fields and adds new ones", async () => {
    const user = userEvent.setup();
    render(
      <EntityEditor
        entity={fridge}
        etag={'"v2"'}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const serial = await screen.findByLabelText("serial number");
    expect((serial as HTMLInputElement).value).toBe("LD-400-17");
    await user.clear(serial);
    await user.type(serial, "LD-400-18");
    await user.type(screen.getByLabelText("New field name"), "hemt_bias");
    await user.type(screen.getByLabelText("New field value"), "#2");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(apiMocks.patchEntity).toHaveBeenCalledWith(
        "instrument",
        fridge.id,
        { serial_number: "LD-400-18", hemt_bias: "#2" },
        '"v2"',
      );
    });
  });

  it("edits a note body through the markdown editor", async () => {
    const user = userEvent.setup();
    render(
      <EntityEditor
        entity={note}
        etag={'"v2"'}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const body = await screen.findByLabelText("Body");
    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeDefined();
    await user.clear(body);
    await user.type(body, "Base reached. Qi looks good.");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(apiMocks.patchEntity).toHaveBeenCalledWith(
        "note",
        note.id,
        { body: "Base reached. Qi looks good." },
        '"v2"',
      );
    });
  });

  it("explains a stale-version conflict instead of overwriting", async () => {
    apiMocks.patchEntity.mockRejectedValue(
      new ApiError(412, "entity is no longer at version 2"),
    );
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(
      <EntityEditor
        entity={fridge}
        etag={'"v2"'}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );

    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Black Fridge");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(/changed since you loaded it/),
    ).toBeDefined();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("keeps boolean extras booleans and edits them with a true/false picker", async () => {
    const user = userEvent.setup();
    render(
      <EntityEditor
        entity={fridge}
        etag={'"v2"'}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const pumped = (await screen.findByLabelText("pumped")) as HTMLSelectElement;
    expect(pumped.tagName).toBe("SELECT");
    expect(pumped.value).toBe("true");
    await user.selectOptions(pumped, "false");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(apiMocks.patchEntity).toHaveBeenCalledWith(
        "instrument",
        fridge.id,
        { pumped: false },
        '"v2"',
      );
    });
  });

  it("blocks saving a number extra that does not parse and shows the field error", async () => {
    const user = userEvent.setup();
    render(
      <EntityEditor
        entity={fridge}
        etag={'"v2"'}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const still = await screen.findByLabelText("still power uw");
    await user.clear(still);
    await user.type(still, "warm");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText("still power uw must be a number."),
    ).toBeDefined();
    expect(apiMocks.patchEntity).not.toHaveBeenCalled();

    // Correcting the value clears the error and saves a number, not a string.
    await user.clear(still);
    await user.type(still, "410");
    expect(screen.queryByText("still power uw must be a number.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(apiMocks.patchEntity).toHaveBeenCalledWith(
        "instrument",
        fridge.id,
        { still_power_uw: 410 },
        '"v2"',
      );
    });
  });

  it("blocks saving a schema number field that does not parse", async () => {
    const user = userEvent.setup();
    render(
      <EntityEditor
        entity={fridge}
        etag={'"v2"'}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const baseTemp = await screen.findByLabelText("Base temp mk");
    await user.type(baseTemp, "8mK");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText("Base temp mk must be a number."),
    ).toBeDefined();
    expect(apiMocks.patchEntity).not.toHaveBeenCalled();

    await user.clear(baseTemp);
    await user.type(baseTemp, "8");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(apiMocks.patchEntity).toHaveBeenCalledWith(
        "instrument",
        fridge.id,
        { base_temp_mk: 8 },
        '"v2"',
      );
    });
  });

  it("closes without a request when nothing changed", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <EntityEditor
        entity={fridge}
        etag={'"v2"'}
        onCancel={onCancel}
        onSaved={vi.fn()}
      />,
    );

    await screen.findByLabelText("Location");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onCancel).toHaveBeenCalled();
    expect(apiMocks.patchEntity).not.toHaveBeenCalled();
  });
});
