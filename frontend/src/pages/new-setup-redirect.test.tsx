import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Entity, type EntityTemplate } from "../api/client";
import { NewEntityPage } from "./new";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

const apiMocks = vi.hoisted(() => ({
  createEntity: vi.fn(),
  getPrinters: vi.fn(),
  getTemplates: vi.fn(),
  listEntities: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, ...apiMocks };
});

const setupTemplate: EntityTemplate = {
  name: "Experiment Setup",
  entity_type: "experiment_setup",
  group: "testing",
  fields: [{ name: "name", label: "Setup Title", type: "text", required: true }],
  body: false,
};

const waferTemplate: EntityTemplate = {
  name: "Wafer",
  entity_type: "wafer",
  group: "fab",
  fields: [{ name: "name", label: "Wafer Name", type: "text", required: true }],
  body: false,
};

function created(entityType: Entity["entity_type"]): Entity {
  return {
    id: "01900000-0000-7000-8000-000000000042",
    accession: "X-2026-0042",
    entity_type: entityType,
    name: "Cooldown 5",
    description: "",
    extra: {},
    source_key: null,
    created_by_id: null,
    created_at: "2026-09-09T20:00:00Z",
    updated_at: "2026-09-09T20:00:00Z",
    version: 0,
  };
}

beforeEach(() => {
  apiMocks.getTemplates.mockReset().mockResolvedValue([setupTemplate, waferTemplate]);
  apiMocks.getPrinters.mockReset().mockResolvedValue([]);
  apiMocks.listEntities.mockReset().mockResolvedValue([]);
  apiMocks.createEntity.mockReset();
});

afterEach(() => {
  cleanup();
});

function renderNew(template: string) {
  return render(
    <MemoryRouter initialEntries={[`/new?template=${encodeURIComponent(template)}`]}>
      <Routes>
        <Route path="/new" element={<NewEntityPage />} />
        <Route path="/entity/:id" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("NewEntityPage after create", () => {
  it("opens a new experiment setup's page directly", async () => {
    apiMocks.createEntity.mockResolvedValue(created("experiment_setup"));
    const user = userEvent.setup();
    renderNew("Experiment Setup");
    await user.type(await screen.findByLabelText("Setup Title *"), "Cooldown 5");
    await user.click(screen.getByRole("button", { name: "Create experiment setup" }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/entity/01900000-0000-7000-8000-000000000042",
      ),
    );
  });

  it("keeps the success card for other records", async () => {
    apiMocks.createEntity.mockResolvedValue(created("wafer"));
    const user = userEvent.setup();
    renderNew("Wafer");
    await user.type(await screen.findByLabelText("Wafer Name *"), "W5");
    await user.click(screen.getByRole("button", { name: "Create wafer" }));
    expect(await screen.findByText("Created X-2026-0042")).toBeTruthy();
    expect(screen.queryByTestId("location")).toBeNull();
  });
});
