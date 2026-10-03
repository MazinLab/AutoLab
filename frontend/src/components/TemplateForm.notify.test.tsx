import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Entity, EntityTemplate, EntityType } from "../api/client";
import { TemplateForm } from "./TemplateForm";

const apiMocks = vi.hoisted(() => ({
  createEntity: vi.fn(),
  getPrinters: vi.fn(),
  listEntities: vi.fn(),
  postNotify: vi.fn(),
  searchEntities: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createEntity: apiMocks.createEntity,
    getPrinters: apiMocks.getPrinters,
    listEntities: apiMocks.listEntities,
    postNotify: apiMocks.postNotify,
    searchEntities: apiMocks.searchEntities,
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
    created_at: "2026-08-08T20:00:00Z",
    updated_at: "2026-08-08T20:00:00Z",
    version: 0,
    ...overrides,
  };
}

const deviceTemplate: EntityTemplate = {
  name: "Device",
  entity_type: "device",
  fields: [{ name: "name", label: "Device Name", type: "text" }],
  body: false,
  notify: true,
};

beforeEach(() => {
  apiMocks.getPrinters.mockResolvedValue([]);
  apiMocks.listEntities.mockResolvedValue([]);
  apiMocks.postNotify.mockResolvedValue(undefined);
  apiMocks.searchEntities.mockResolvedValue([
    {
      id: "p1",
      accession: "PER-2026-0002",
      entity_type: "person",
      name: "Gregoire",
      snippet: "",
    },
  ]);
  apiMocks.createEntity.mockResolvedValue(
    entity("d1", "DEV-2026-0001", "device", { name: "MKID-1" }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TemplateForm notify picker", () => {
  it("hides the picker when the template has no notify flag", () => {
    render(
      <TemplateForm
        template={{ ...deviceTemplate, notify: undefined }}
      />,
    );
    expect(screen.queryByText("Notify people")).toBeNull();
  });

  it("notifies the selected people after a successful create", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={deviceTemplate} />);

    await user.type(screen.getByLabelText(/Device Name/), "MKID-1");
    await user.type(
      screen.getByLabelText("Notify people"),
      "greg",
    );
    await user.click(await screen.findByText("Gregoire"));
    expect(screen.getByText("Gregoire")).toBeDefined(); // the chip

    await user.click(
      screen.getByRole("button", { name: /Create device/ }),
    );

    await waitFor(() => {
      expect(apiMocks.postNotify).toHaveBeenCalledWith({
        person_ids: ["p1"],
        entity_id: "d1",
      });
    });
  });

  it("warns that offline-queued records send no notifications", async () => {
    apiMocks.createEntity.mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    const user = userEvent.setup();
    render(<TemplateForm template={deviceTemplate} />);

    await user.type(screen.getByLabelText(/Device Name/), "MKID-1");
    await user.type(screen.getByLabelText("Notify people"), "greg");
    await user.click(await screen.findByText("Gregoire"));
    await user.click(
      screen.getByRole("button", { name: /Create device/ }),
    );

    expect(
      await screen.findByText(/do not send notifications/),
    ).toBeDefined();
    expect(apiMocks.postNotify).not.toHaveBeenCalled();
  });

  it("warns without failing the create when the notify call fails", async () => {
    apiMocks.postNotify.mockRejectedValue(new Error("gate"));
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(
      <TemplateForm onCreated={onCreated} template={deviceTemplate} />,
    );

    await user.type(screen.getByLabelText(/Device Name/), "MKID-1");
    await user.type(screen.getByLabelText("Notify people"), "greg");
    await user.click(await screen.findByText("Gregoire"));
    await user.click(
      screen.getByRole("button", { name: /Create device/ }),
    );

    expect(
      await screen.findByText(/notification could not be queued/),
    ).toBeDefined();
    expect(onCreated).toHaveBeenCalled();
  });
});
