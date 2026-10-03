import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACTOR_STORAGE_KEY,
  type Entity,
  type EntityTemplate,
} from "../api/client";
import { ActorPicker, PERSON_CREATED_EVENT } from "../components/ActorPicker";
import { TemplateForm } from "../components/TemplateForm";

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">{location.pathname + location.search}</output>
  );
}

const apiMocks = vi.hoisted(() => ({
  createEntity: vi.fn(),
  listEntities: vi.fn(),
  searchEntities: vi.fn(),
}));

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

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createEntity: apiMocks.createEntity,
    listEntities: apiMocks.listEntities,
    searchEntities: apiMocks.searchEntities,
  };
});

const createdEntity: Entity = {
  id: "01900000-0000-7000-8000-000000000010",
  accession: "N-2026-0001",
  entity_type: "note",
  name: "Cooling observation",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-18T20:00:00Z",
  updated_at: "2026-07-18T20:00:00Z",
  version: 0,
};

const experimentTemplate: EntityTemplate = {
  name: "Experiment",
  entity_type: "note",
  fields: [
    {
      name: "name",
      label: "Log Title",
      type: "text",
      required: true,
    },
  ],
  body: true,
};

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
  apiMocks.createEntity.mockReset();
  apiMocks.listEntities.mockReset();
  apiMocks.searchEntities.mockReset();
  apiMocks.createEntity.mockResolvedValue(createdEntity);
  apiMocks.listEntities.mockResolvedValue([]);
  apiMocks.searchEntities.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("TemplateForm", () => {
  it("records the template name and note fields in the note payload", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={experimentTemplate} />);

    await user.type(screen.getByLabelText(/Log Title/), "Sweep resonators");
    await user.type(
      screen.getByLabelText("Markdown note"),
      "Cooling observation\nReached base temperature.",
    );
    await user.click(screen.getByRole("button", { name: "Create experiment" }));

    // The Log Title field maps straight onto the note's name and takes
    // precedence over the first line of the body.
    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("note", {
        source_key: expect.stringMatching(/^web:/),
        name: "Sweep resonators",
        body: "Cooling observation\nReached base temperature.",
        template: "Experiment",
      });
    });
  });

});

describe("ActorPicker", () => {
  const actor: Entity = {
    ...createdEntity,
    id: "01900000-0000-7000-8000-000000000060",
    accession: "P-2026-0001",
    entity_type: "person",
    name: "Ben Mazin",
  };

  it("routes to the person template from the add option without changing the actor", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/queue"]}>
        <ActorPicker />
        <LocationProbe />
      </MemoryRouter>,
    );

    await user.selectOptions(
      await screen.findByLabelText("Actor"),
      "+ Add a person…",
    );

    expect(screen.getByTestId("location").textContent).toBe(
      "/new?template=Person&actor=1",
    );
    expect(window.localStorage.getItem(ACTOR_STORAGE_KEY)).toBeNull();
  });

  it("refreshes and adopts a person announced by the created event", async () => {
    apiMocks.listEntities.mockImplementation((entityType: string) =>
      Promise.resolve(entityType === "person" ? [actor] : []),
    );
    render(
      <MemoryRouter>
        <ActorPicker />
      </MemoryRouter>,
    );
    const select = (await screen.findByLabelText("Actor")) as HTMLSelectElement;

    window.dispatchEvent(
      new CustomEvent(PERSON_CREATED_EVENT, {
        detail: { id: actor.id, select: true },
      }),
    );

    await waitFor(() => {
      expect(select.value).toBe(actor.id);
    });
  });
});
