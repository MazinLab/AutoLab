import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { ActivityPage } from "./activity";
import type { Entity, FeedItem, FeedPage } from "../api/client";

const apiMocks = vi.hoisted(() => ({
  getFeed: vi.fn(),
  listEntities: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    getFeed: apiMocks.getFeed,
    listEntities: apiMocks.listEntities,
  };
});


// Mirrors the page's local-day conversion: the inputs pick local calendar
// days; the query sends UTC instants covering that local day exactly.
function localDayStart(date: string): string {
  return new Date(`${date}T00:00:00`).toISOString();
}

function localDayEnd(date: string): string {
  const nextMidnight = new Date(`${date}T00:00:00`);
  nextMidnight.setDate(nextMidnight.getDate() + 1);
  return new Date(nextMidnight.getTime() - 1).toISOString();
}

function feedItem(overrides: Partial<FeedItem>): FeedItem {
  return {
    id: "01900000-0000-7000-8000-000000000001",
    at: "2026-07-20T18:04:00+00:00",
    actor_id: null,
    action: "created",
    entity_id: "01900000-0000-7000-8000-000000000002",
    payload: {},
    entity: {
      id: "01900000-0000-7000-8000-000000000002",
      entity_type: "wafer",
      accession: "W-2026-0001",
      name: "Trilayer wafer",
    },
    actor: null,
    ...overrides,
  };
}

const benPerson = {
  id: "01900000-0000-7000-8000-000000000009",
  accession: "P-2026-0001",
  entity_type: "person",
  name: "Ben Mazin",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-18T20:00:00Z",
  updated_at: "2026-07-18T20:00:00Z",
  version: 1,
} as Entity;

beforeEach(() => {
  apiMocks.listEntities.mockImplementation((entityType: string) =>
    Promise.resolve(entityType === "person" ? [benPerson] : []),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ActivityPage", () => {
  it("renders feed items newest first with entity links and actors", async () => {
    const page: FeedPage = {
      items: [
        feedItem({
          id: "01900000-0000-7000-8000-00000000000a",
          action: "updated",
          actor: {
            id: "01900000-0000-7000-8000-000000000009",
            entity_type: "person",
            accession: "P-2026-0001",
            name: "Ben Mazin",
          },
        }),
        feedItem({
          id: "01900000-0000-7000-8000-00000000000b",
          at: "2026-07-19T10:00:00+00:00",
          entity: {
            id: "01900000-0000-7000-8000-000000000003",
            entity_type: "device",
            accession: "DEV-2026-0001",
            name: "C1",
          },
        }),
      ],
      next_cursor: null,
    };
    apiMocks.getFeed.mockResolvedValue(page);

    render(
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Trilayer wafer")).toBeDefined();
    expect(screen.getByText("C1")).toBeDefined();
    expect(screen.getByText("by Ben Mazin")).toBeDefined();
    expect(screen.getByText("W-2026-0001")).toBeDefined();
    const link = screen.getByRole("link", { name: "Trilayer wafer" });
    expect(link.getAttribute("href")).toBe(
      "/entity/01900000-0000-7000-8000-000000000002",
    );
    expect(apiMocks.getFeed).toHaveBeenCalledWith({
      limit: 50,
      actions: "created,updated",
    });
    // no cursor -> no load-more control
    expect(screen.queryByRole("button", { name: /older activity/i })).toBeNull();
  });

  it("loads older pages through the cursor", async () => {
    apiMocks.getFeed
      .mockResolvedValueOnce({
        items: [feedItem({ id: "01900000-0000-7000-8000-00000000000a" })],
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        items: [
          feedItem({
            id: "01900000-0000-7000-8000-00000000000b",
            at: "2026-07-18T09:00:00+00:00",
            entity: {
              id: "01900000-0000-7000-8000-000000000004",
              entity_type: "note",
              accession: "N-2026-0001",
              name: "Older note",
            },
          }),
        ],
        next_cursor: null,
      });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>,
    );

    await user.click(
      await screen.findByRole("button", { name: /older activity/i }),
    );

    expect(await screen.findByText("Older note")).toBeDefined();
    expect(apiMocks.getFeed).toHaveBeenLastCalledWith({
      limit: 50,
      actions: "created,updated",
      before: "cursor-1",
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /older activity/i }),
      ).toBeNull();
    });
  });

  it("shows the empty state when there is no activity", async () => {
    apiMocks.getFeed.mockResolvedValue({ items: [], next_cursor: null });

    render(
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("No catalog activity matches these filters."),
    ).toBeDefined();
  });

  it("refetches the feed when action, type, and actor filters change", async () => {
    apiMocks.getFeed.mockResolvedValue({ items: [], next_cursor: null });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(apiMocks.getFeed).toHaveBeenCalledWith({
        limit: 50,
        actions: "created,updated",
      }),
    );

    // Toggling an action adds it in canonical order and resets the feed.
    await user.click(screen.getByRole("button", { name: "deleted" }));
    await waitFor(() =>
      expect(apiMocks.getFeed).toHaveBeenLastCalledWith({
        limit: 50,
        actions: "created,updated,deleted",
      }),
    );

    await user.selectOptions(
      screen.getByLabelText("Record type"),
      "wafer",
    );
    await waitFor(() =>
      expect(apiMocks.getFeed).toHaveBeenLastCalledWith({
        limit: 50,
        actions: "created,updated,deleted",
        entityType: "wafer",
      }),
    );

    // Actor choices are populated from person + agent entities.
    await user.selectOptions(
      screen.getByLabelText("Actor"),
      benPerson.id,
    );
    await waitFor(() =>
      expect(apiMocks.getFeed).toHaveBeenLastCalledWith({
        limit: 50,
        actions: "created,updated,deleted",
        entityType: "wafer",
        actor: benPerson.id,
      }),
    );

    // The last remaining action cannot be toggled off (empty would be
    // ambiguous), so the query is unchanged.
    await user.click(screen.getByRole("button", { name: "created" }));
    await user.click(screen.getByRole("button", { name: "updated" }));
    const callsBefore = apiMocks.getFeed.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "deleted" }));
    expect(apiMocks.getFeed).toHaveBeenLastCalledWith({
      limit: 50,
      actions: "deleted",
      entityType: "wafer",
      actor: benPerson.id,
    });
    expect(apiMocks.getFeed.mock.calls.length).toBe(callsBefore);
  });

  it("maps the From and To dates into feed since/until bounds", async () => {
    apiMocks.getFeed.mockResolvedValue({ items: [], next_cursor: null });

    render(
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(apiMocks.getFeed).toHaveBeenCalledWith({
        limit: 50,
        actions: "created,updated",
      }),
    );

    const fromInput = screen.getByLabelText("From");
    const toInput = screen.getByLabelText("To");

    // Setting a lower bound maps to a start-of-day since.
    fireEvent.change(fromInput, { target: { value: "2026-08-01" } });
    await waitFor(() =>
      expect(apiMocks.getFeed).toHaveBeenLastCalledWith({
        limit: 50,
        actions: "created,updated",
        since: localDayStart("2026-08-01"),
      }),
    );

    // Setting an upper bound adds an end-of-day until.
    fireEvent.change(toInput, { target: { value: "2026-08-07" } });
    await waitFor(() =>
      expect(apiMocks.getFeed).toHaveBeenLastCalledWith({
        limit: 50,
        actions: "created,updated",
        since: localDayStart("2026-08-01"),
        until: localDayEnd("2026-08-07"),
      }),
    );

    // Clearing the inputs removes the bounds again.
    fireEvent.change(fromInput, { target: { value: "" } });
    fireEvent.change(toInput, { target: { value: "" } });
    await waitFor(() =>
      expect(apiMocks.getFeed).toHaveBeenLastCalledWith({
        limit: 50,
        actions: "created,updated",
      }),
    );
  });

  it("resets pagination when the date range changes", async () => {
    apiMocks.getFeed.mockResolvedValue({
      items: [feedItem({ id: "01900000-0000-7000-8000-00000000000a" })],
      next_cursor: "cursor-1",
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>,
    );

    await screen.findByRole("button", { name: /older activity/i });
    await user.click(screen.getByRole("button", { name: /older activity/i }));
    await waitFor(() =>
      expect(apiMocks.getFeed).toHaveBeenLastCalledWith({
        limit: 50,
        actions: "created,updated",
        before: "cursor-1",
      }),
    );

    // A new date bound refetches from the top: no cursor in the query.
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-08-01" },
    });
    await waitFor(() =>
      expect(apiMocks.getFeed).toHaveBeenLastCalledWith({
        limit: 50,
        actions: "created,updated",
        since: localDayStart("2026-08-01"),
      }),
    );
  });

  it("renders deleted and unlinked events from the event payload", async () => {
    apiMocks.getFeed.mockResolvedValue({
      items: [
        feedItem({
          id: "01900000-0000-7000-8000-00000000000d",
          action: "deleted",
          entity: null,
          payload: {
            accession: "W-2026-0009",
            entity_type: "wafer",
            name: "Scrapped wafer",
          },
        }),
        feedItem({
          id: "01900000-0000-7000-8000-00000000000e",
          at: "2026-07-19T10:00:00+00:00",
          action: "unlinked",
          entity: null,
          payload: {
            relation: "refers_to",
            dst_id: "01900000-0000-7000-8000-000000000077",
          },
        }),
      ],
      next_cursor: null,
    });

    render(
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>,
    );

    // Deleted entities are gone; their payload identity renders with a badge.
    // Scope to the feed list: "deleted"/"wafer" also label filter controls.
    expect(await screen.findByText("Scrapped wafer")).toBeDefined();
    const feed = screen.getByRole("list");
    expect(within(feed).getByText("deleted")).toBeDefined();
    expect(within(feed).getByText("W-2026-0009")).toBeDefined();
    expect(within(feed).getByText("wafer")).toBeDefined();
    // No entity link for a deleted record.
    expect(screen.queryByRole("link", { name: "Scrapped wafer" })).toBeNull();

    // Unlinked events show the removed relation and destination.
    expect(within(feed).getByText("unlinked")).toBeDefined();
    expect(
      within(feed).getByText(/refers_to → 01900000-0000-7000-8000-000000000077/),
    ).toBeDefined();
    expect(
      within(feed).getByText("(entity no longer resolvable)"),
    ).toBeDefined();
  });
});
