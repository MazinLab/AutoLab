import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Entity, type EntityTemplate } from "../api/client";
import { TemplateForm } from "./TemplateForm";

const apiMocks = vi.hoisted(() => ({
  createEntity: vi.fn(),
  getPrinters: vi.fn(),
  listEntities: vi.fn(),
}));

const outboxMocks = vi.hoisted(() => ({
  enqueueCreate: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createEntity: apiMocks.createEntity,
    getPrinters: apiMocks.getPrinters,
    listEntities: apiMocks.listEntities,
  };
});

vi.mock("../offline/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../offline/outbox")>();
  return {
    ...actual,
    enqueueCreate: outboxMocks.enqueueCreate,
  };
});

const waferTemplate: EntityTemplate = {
  name: "Wafer",
  batch: true,
  entity_type: "wafer",
  fields: [{ name: "name", label: "Wafer Name", type: "text", required: true }],
  body: false,
};

function createdWafer(name: string): Entity {
  return {
    id: "01900000-0000-7000-8000-000000000001",
    accession: "W-2026-0001",
    entity_type: "wafer",
    name,
    description: "",
    extra: {},
    source_key: null,
    created_by_id: null,
    created_at: "2026-08-08T10:00:00Z",
    updated_at: "2026-08-08T10:00:00Z",
    version: 0,
  };
}

function sourceKeyOf(call: unknown[]): string {
  return (call[1] as { source_key: string }).source_key;
}

beforeEach(() => {
  apiMocks.createEntity.mockReset();
  apiMocks.getPrinters.mockReset().mockResolvedValue([]);
  apiMocks.listEntities.mockReset().mockResolvedValue([]);
  outboxMocks.enqueueCreate.mockReset().mockImplementation(
    (entityType: string, payload: Record<string, unknown>) => ({
      id: "queued-1",
      entityType,
      payload,
      queuedAt: "2026-08-08T10:00:00Z",
    }),
  );
});

afterEach(cleanup);

describe("TemplateForm offline idempotency", () => {
  it("queues the failed create under the SAME source_key as the direct POST", async () => {
    apiMocks.createEntity.mockRejectedValue(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    render(<TemplateForm template={waferTemplate} />);

    await user.type(screen.getByLabelText(/Wafer Name/), "W20260808-1");
    await user.click(screen.getByRole("button", { name: "Create wafer" }));

    expect(
      await screen.findByText(/queued and will sync/),
    ).toBeDefined();
    expect(apiMocks.createEntity).toHaveBeenCalledTimes(1);
    expect(outboxMocks.enqueueCreate).toHaveBeenCalledTimes(1);
    // If the POST actually reached the server before the connection died,
    // the outbox replay must dedupe — identical key, no duplicate record.
    const postedKey = sourceKeyOf(apiMocks.createEntity.mock.calls[0]);
    expect(postedKey).toMatch(/^web:/);
    expect(outboxMocks.enqueueCreate).toHaveBeenCalledWith("wafer", {
      name: "W20260808-1",
      source_key: postedKey,
    });
  });

  it("queues only the uncreated copies of a batch, each under its own key", async () => {
    apiMocks.createEntity
      .mockResolvedValueOnce(createdWafer("W20260808-01"))
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    render(<TemplateForm template={waferTemplate} />);

    await user.type(screen.getByLabelText(/Wafer Name/), "W20260808");
    const copiesInput = screen.getByLabelText("Copies");
    await user.clear(copiesInput);
    await user.type(copiesInput, "2");
    await user.click(screen.getByRole("button", { name: "Create 2 records" }));

    await waitFor(() => {
      expect(outboxMocks.enqueueCreate).toHaveBeenCalledTimes(1);
    });
    // The first copy committed; only the second is queued, and it keeps the
    // key it was POSTed under.
    const secondKey = sourceKeyOf(apiMocks.createEntity.mock.calls[1]);
    expect(outboxMocks.enqueueCreate).toHaveBeenCalledWith("wafer", {
      name: "W20260808-02",
      source_key: secondKey,
    });
    expect(secondKey).not.toBe(
      sourceKeyOf(apiMocks.createEntity.mock.calls[0]),
    );
  });

  it("keeps the draft and shows an error when the queue cannot be persisted", async () => {
    apiMocks.createEntity.mockRejectedValue(new TypeError("Failed to fetch"));
    outboxMocks.enqueueCreate.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const user = userEvent.setup();
    render(<TemplateForm template={waferTemplate} />);

    await user.type(screen.getByLabelText(/Wafer Name/), "W20260808-1");
    await user.click(screen.getByRole("button", { name: "Create wafer" }));

    // No false "queued" reassurance: nothing was stored anywhere.
    expect(
      await screen.findByText(/could not be queued/),
    ).toBeDefined();
    expect(screen.queryByText(/queued and will sync/)).toBeNull();
    // The typed data survives for a manual retry.
    expect(
      (screen.getByLabelText(/Wafer Name/) as HTMLInputElement).value,
    ).toBe("W20260808-1");
  });

  it("mints fresh keys for the next record after a confirmed create", async () => {
    apiMocks.createEntity.mockResolvedValue(createdWafer("W20260808-1"));
    const user = userEvent.setup();
    render(<TemplateForm template={waferTemplate} />);

    await user.type(screen.getByLabelText(/Wafer Name/), "W20260808-1");
    await user.click(screen.getByRole("button", { name: "Create wafer" }));
    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledTimes(1);
    });

    // "Create another": the form stays mounted and is resubmitted as a NEW
    // logical record, so the key must differ.
    await user.click(screen.getByRole("button", { name: "Create wafer" }));
    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledTimes(2);
    });
    expect(sourceKeyOf(apiMocks.createEntity.mock.calls[1])).not.toBe(
      sourceKeyOf(apiMocks.createEntity.mock.calls[0]),
    );
  });
});
