import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

import type { Entity } from "../api/client";
import { MountPage } from "./mount";

const apiMocks = vi.hoisted(() => ({
  createEdge: vi.fn(),
  createEntity: vi.fn(),
  getLineageGraph: vi.fn(),
  listEntities: vi.fn(),
  resolveAccession: vi.fn(),
}));

vi.mock("../api/client", () => apiMocks);

vi.mock("../scanner/useScanner", () => ({
  useScanner: () => ({
    videoRef: { current: null },
    status: "unavailable",
    error: null,
  }),
}));

function entity(
  accession: string,
  entityType: Entity["entity_type"],
  overrides: Partial<Entity> = {},
): Entity {
  return {
    id: `${entityType}-${accession}`,
    accession,
    entity_type: entityType,
    name: accession,
    description: "",
    extra: {},
    source_key: null,
    created_by_id: null,
    created_at: "2026-07-18T20:00:00Z",
    updated_at: "2026-07-18T20:00:00Z",
    version: 1,
    ...overrides,
  };
}

const instrument = entity("INST-2026-0001", "instrument", {
  id: "instrument-1",
  name: "Blue fridge",
});
const device = entity("DEV-2026-0002", "device", {
  id: "device-2",
  name: "Array 2",
});
const openCooldown = entity("CD-2026-0003", "experiment_setup", {
  id: "cooldown-3",
  name: "July run",
  ended_at: null,
});
const closedCooldown = entity("CD-2026-0004", "experiment_setup", {
  id: "cooldown-4",
  ended_at: "2026-07-18T22:00:00Z",
});
const otherCooldown = entity("CD-2026-0005", "experiment_setup", {
  id: "cooldown-5",
  ended_at: null,
});

function performedOnGraph(instrumentId: string, cooldowns: Entity[]) {
  return {
    nodes: cooldowns.map((cooldown) => ({
      id: cooldown.id,
      entity_type: cooldown.entity_type,
      accession: cooldown.accession,
      depth: 1,
    })),
    edges: cooldowns.map((cooldown) => ({
      src_id: cooldown.id,
      dst_id: instrumentId,
      relation: "performed_on" as const,
    })),
  };
}

async function submitAccession(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  value: string,
  button: string,
): Promise<void> {
  await user.type(screen.getByLabelText(label), value);
  await user.click(screen.getByRole("button", { name: button }));
}

beforeEach(() => {
  apiMocks.createEdge.mockReset().mockResolvedValue({ id: "edge-1" });
  apiMocks.createEntity.mockReset();
  // The instrument is linked (PERFORMED_ON) to the open and closed cooldowns
  // only; otherCooldown belongs to a different instrument and is absent here.
  apiMocks.getLineageGraph
    .mockReset()
    .mockResolvedValue(performedOnGraph(instrument.id, [openCooldown, closedCooldown]));
  apiMocks.listEntities
    .mockReset()
    .mockResolvedValue([openCooldown, closedCooldown, otherCooldown]);
  apiMocks.resolveAccession.mockReset().mockImplementation((accession: string) => {
    const resolved = new Map([
      [instrument.accession, instrument],
      [device.accession, device],
    ]).get(accession);
    if (!resolved) {
      throw new Error(`Unknown accession ${accession}`);
    }
    return Promise.resolve({ data: resolved, etag: '"v1"' });
  });
});

afterEach(() => {
  cleanup();
});

describe("MountPage", () => {
  it("selects a linked open cooldown and mounts a scanned device", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MountPage />
      </MemoryRouter>,
    );

    await submitAccession(
      user,
      "Instrument accession",
      instrument.accession,
      "Use instrument",
    );

    expect(await screen.findByRole("heading", { name: "Choose a setup" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /CD-2026-0003/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /CD-2026-0004/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /CD-2026-0005/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /CD-2026-0003/ }));
    await submitAccession(
      user,
      "Device accession",
      device.accession,
      "Mount device",
    );

    expect(await screen.findByRole("heading", { name: "Device mounted" })).toBeTruthy();
    expect(apiMocks.createEdge).toHaveBeenCalledWith({
      src_id: device.id,
      relation: "mounted_in",
      dst_id: openCooldown.id,
    });
    expect(
      screen.getByRole("link", { name: /DEV-2026-0002/ }).getAttribute("href"),
    ).toBe("/e/DEV-2026-0002");
    expect(screen.getByRole("link", { name: /CD-2026-0003/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /INST-2026-0001/ })).toBeTruthy();
  });

  it("creates a cooldown, retains it after a link failure, and retries the edge", async () => {
    const user = userEvent.setup();
    const createdCooldown = entity("CD-2026-0010", "experiment_setup", {
      id: "cooldown-10",
      name: "Fresh run",
      ended_at: null,
    });
    apiMocks.listEntities.mockResolvedValue([]);
    apiMocks.getLineageGraph.mockResolvedValue(performedOnGraph(instrument.id, []));
    apiMocks.createEntity.mockResolvedValue(createdCooldown);
    apiMocks.createEdge
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValue({ id: "edge-2" });

    render(
      <MemoryRouter>
        <MountPage />
      </MemoryRouter>,
    );
    await submitAccession(
      user,
      "Instrument accession",
      instrument.accession,
      "Use instrument",
    );
    await screen.findByText("No open cooldowns are linked to this instrument.");
    await user.type(screen.getByLabelText("New setup name (optional)"), "Fresh run");
    await user.click(screen.getByRole("button", { name: "Create setup" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Setup created, but its instrument link failed",
    );
    expect(apiMocks.createEntity).toHaveBeenCalledOnce();
    expect(apiMocks.createEdge).toHaveBeenNthCalledWith(1, {
      src_id: createdCooldown.id,
      relation: "performed_on",
      dst_id: instrument.id,
    });

    await user.click(
      screen.getByRole("button", {
        name: `Retry instrument link for ${createdCooldown.accession}`,
      }),
    );

    expect(await screen.findByRole("heading", { name: "Scan the device" })).toBeTruthy();
    expect(apiMocks.createEntity).toHaveBeenCalledOnce();
    expect(apiMocks.createEdge).toHaveBeenNthCalledWith(2, {
      src_id: createdCooldown.id,
      relation: "performed_on",
      dst_id: instrument.id,
    });
  });

  it("rejects scanned entities with the wrong type at both scan steps", async () => {
    const user = userEvent.setup();
    const wafer = entity("W-2026-0012", "wafer");
    apiMocks.resolveAccession.mockImplementation((accession: string) => {
      const resolved = new Map([
        [wafer.accession, wafer],
        [instrument.accession, instrument],
      ]).get(accession);
      return Promise.resolve({ data: resolved, etag: null });
    });

    render(
      <MemoryRouter>
        <MountPage />
      </MemoryRouter>,
    );
    await submitAccession(
      user,
      "Instrument accession",
      wafer.accession,
      "Use instrument",
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "W-2026-0012 has type wafer; expected an instrument.",
    );
    expect(screen.getByLabelText("Instrument accession")).toBeTruthy();

    await user.clear(screen.getByLabelText("Instrument accession"));
    await submitAccession(
      user,
      "Instrument accession",
      instrument.accession,
      "Use instrument",
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Choose a setup" })).toBeTruthy();
    });
    await user.click(screen.getByRole("button", { name: /CD-2026-0003/ }));
    await submitAccession(
      user,
      "Device accession",
      instrument.accession,
      "Mount device",
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "INST-2026-0001 has type instrument; expected a device.",
    );
    expect(apiMocks.createEdge).not.toHaveBeenCalled();
  });
});
