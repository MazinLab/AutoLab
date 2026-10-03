import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { ActorPicker } from "./ActorPicker";
import type { Entity, Whoami } from "../api/client";
import { ACTOR_STORAGE_KEY } from "../api/client";

const apiMocks = vi.hoisted(() => ({
  listEntities: vi.fn(),
  getWhoami: vi.fn(),
  patchEntity: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    listEntities: apiMocks.listEntities,
    getWhoami: apiMocks.getWhoami,
    patchEntity: apiMocks.patchEntity,
  };
});

function person(overrides: Partial<Entity>): Entity {
  return {
    id: "01900000-0000-7000-8000-000000000001",
    accession: "P-2026-0001",
    entity_type: "person",
    name: "Ben Mazin",
    description: "",
    extra: {},
    source_key: null,
    created_by_id: null,
    created_at: "2026-07-20T00:00:00Z",
    updated_at: "2026-07-20T00:00:00Z",
    version: 0,
    ...overrides,
  };
}

const ben = person({});
const gregoire = person({
  id: "01900000-0000-7000-8000-000000000002",
  accession: "P-2026-0002",
  name: "Gregoire",
});

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
  apiMocks.listEntities.mockImplementation((entityType: string) =>
    Promise.resolve(entityType === "person" ? [ben, gregoire] : []),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ActorPicker network identity", () => {
  it("labels the default option with the resolved person", async () => {
    const whoami: Whoami = { login: "ben@github", person: ben, mapped: true };
    apiMocks.getWhoami.mockResolvedValue(whoami);

    render(
      <MemoryRouter>
        <ActorPicker />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Ben Mazin (you)")).toBeDefined();
  });

  it("hides the resolved person from the roster", async () => {
    apiMocks.getWhoami.mockResolvedValue({
      login: "ben@github",
      person: ben,
      mapped: true,
    });

    render(
      <MemoryRouter>
        <ActorPicker />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Gregoire — person")).toBeDefined();
    expect(screen.queryByText("Ben Mazin — person")).toBeNull();
  });

  it("collapses a stale self-pin back to the identity default", async () => {
    window.localStorage.setItem(ACTOR_STORAGE_KEY, ben.id);
    apiMocks.getWhoami.mockResolvedValue({
      login: "ben@github",
      person: ben,
      mapped: true,
    });

    render(
      <MemoryRouter>
        <ActorPicker />
      </MemoryRouter>,
    );

    const select = await screen.findByLabelText<HTMLSelectElement>("Actor");
    await waitFor(() => {
      expect(select.value).toBe("");
    });
    expect(window.localStorage.getItem(ACTOR_STORAGE_KEY)).toBeNull();
  });

  it("shows an acting-as note when the selection differs from the identity", async () => {
    apiMocks.getWhoami.mockResolvedValue({
      login: "ben@github",
      person: ben,
      mapped: true,
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <ActorPicker />
      </MemoryRouter>,
    );
    await user.selectOptions(
      await screen.findByLabelText("Actor"),
      gregoire.id,
    );

    expect(
      await screen.findByText(/Acting as Gregoire — person — you are Ben Mazin/),
    ).toBeDefined();
  });

  it("offers to link an unmapped login to the selected person", async () => {
    apiMocks.getWhoami.mockResolvedValue({
      login: "new@github",
      person: null,
      mapped: false,
    });
    apiMocks.patchEntity.mockResolvedValue({
      data: { ...ben, tailscale_login: "new@github" },
      etag: '"v1"',
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <ActorPicker />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Signed in as new@github/)).toBeDefined();

    await user.selectOptions(await screen.findByLabelText("Actor"), ben.id);
    await user.click(
      screen.getByRole("button", { name: "Link to selected person" }),
    );

    expect(apiMocks.patchEntity).toHaveBeenCalledWith("person", ben.id, {
      tailscale_login: "new@github",
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Link to selected person" }),
      ).toBeNull();
    });
  });

  it("keeps plain behavior when identity is unavailable", async () => {
    apiMocks.getWhoami.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <ActorPicker />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Unattributed")).toBeDefined();
    await user.selectOptions(await screen.findByLabelText("Actor"), ben.id);
    expect(window.localStorage.getItem(ACTOR_STORAGE_KEY)).toBe(ben.id);
  });
});
