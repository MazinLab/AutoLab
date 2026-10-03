import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Entity, EventRecord } from "../api/client";
import { ReviewQueuePage } from "./queue";

const apiMocks = vi.hoisted(() => ({
  getEntity: vi.fn(),
  getEntityEvents: vi.fn(),
  listEntitiesPage: vi.fn(),
  patchEntity: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    getEntity: apiMocks.getEntity,
    getEntityEvents: apiMocks.getEntityEvents,
    listEntitiesPage: apiMocks.listEntitiesPage,
    patchEntity: apiMocks.patchEntity,
  };
});

function reviewTask(index: number, status = "open"): Entity & { status: string } {
  return {
    id: `01900000-0000-7000-8000-${String(index).padStart(12, "0")}`,
    accession: `RT-2026-${String(index).padStart(4, "0")}`,
    entity_type: "review_task",
    name: `Review task ${index}`,
    description: "Agent-proposed catalog annotation.",
    status,
    extra: {},
    source_key: null,
    created_by_id: null,
    created_at: "2026-07-18T20:00:00Z",
    updated_at: "2026-07-18T20:00:00Z",
    version: 0,
  };
}

function linkedEvent(
  taskId: string,
  relation: "annotates" | "refers_to",
  destinationId: string,
  index: number,
): EventRecord {
  return {
    id: `01900000-0000-7000-9000-${String(index).padStart(12, "0")}`,
    at: `2026-07-18T20:00:0${index}Z`,
    actor_id: null,
    action: "linked",
    entity_id: taskId,
    payload: { dst_id: destinationId, relation },
  };
}

function renderQueue(): void {
  render(
    <MemoryRouter>
      <ReviewQueuePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMocks.getEntity.mockReset();
  apiMocks.getEntityEvents.mockReset();
  apiMocks.listEntitiesPage.mockReset();
  apiMocks.patchEntity.mockReset();
  apiMocks.getEntityEvents.mockResolvedValue({ events: [], next_cursor: null });
});

afterEach(() => {
  cleanup();
});

describe("ReviewQueuePage revision fixes", () => {
  it("renders annotation target and evidence from the task's own event stream", async () => {
    const task = reviewTask(1);
    const targetId = "01900000-0000-7000-8000-000000000201";
    const evidenceId = "01900000-0000-7000-8000-000000000202";
    apiMocks.listEntitiesPage.mockResolvedValue({ rows: [task], total: 1 });
    apiMocks.getEntity.mockResolvedValue({ data: task, etag: '"v0"' });
    apiMocks.getEntityEvents.mockResolvedValue({
      events: [
        linkedEvent(task.id, "annotates", targetId, 1),
        linkedEvent(task.id, "refers_to", evidenceId, 2),
      ],
      next_cursor: null,
    });

    renderQueue();

    expect(await screen.findByText("Annotation target")).toBeTruthy();
    expect(
      (await screen.findByRole("link", { name: targetId })).getAttribute("href"),
    ).toBe(`/entity/${targetId}`);
    expect(
      (await screen.findByRole("link", { name: evidenceId })).getAttribute("href"),
    ).toBe(`/entity/${evidenceId}`);
    expect(screen.queryByText("No linked evidence")).toBeNull();
    // The bounded per-entity endpoint is used, never the full event log.
    expect(apiMocks.getEntityEvents).toHaveBeenCalledWith(task.id, {
      limit: 200,
    });
  });
});
