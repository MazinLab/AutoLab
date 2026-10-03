import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Entity, Subscription } from "../api/client";
import { SubscriptionManager } from "./SubscriptionManager";

const apiMocks = vi.hoisted(() => ({
  createSubscription: vi.fn(),
  deleteSubscription: vi.fn(),
  getWhoami: vi.fn(),
  listSubscriptions: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createSubscription: apiMocks.createSubscription,
    deleteSubscription: apiMocks.deleteSubscription,
    getWhoami: apiMocks.getWhoami,
    listSubscriptions: apiMocks.listSubscriptions,
  };
});

const me: Entity = {
  id: "me-1",
  accession: "PER-2026-0001",
  entity_type: "person",
  name: "Ben Mazin",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-08-08T00:00:00Z",
  updated_at: "2026-08-08T00:00:00Z",
  version: 0,
};

const waferSub: Subscription = {
  id: "sub-1",
  person_id: "me-1",
  entity_type: "wafer",
  action: "created",
  filters: {},
  created_at: "2026-08-08T00:00:00Z",
};

beforeEach(() => {
  apiMocks.getWhoami.mockResolvedValue({
    login: "bmazin",
    person: me,
    mapped: true,
    can_write: true,
  });
  apiMocks.listSubscriptions.mockResolvedValue([waferSub]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SubscriptionManager", () => {
  it("renders nothing on someone else's person page", async () => {
    render(<SubscriptionManager personId="someone-else" />);
    await waitFor(() => expect(apiMocks.getWhoami).toHaveBeenCalled());
    expect(screen.queryByText("Notification subscriptions")).toBeNull();
    expect(apiMocks.listSubscriptions).not.toHaveBeenCalled();
  });

  it("lists and deletes your subscriptions", async () => {
    apiMocks.deleteSubscription.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<SubscriptionManager personId="me-1" />);

    expect(await screen.findByText("wafer created")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(apiMocks.deleteSubscription).toHaveBeenCalledWith("sub-1"),
    );
    expect(screen.queryByText("wafer created")).toBeNull();
  });

  it("creates a subscription from the add row", async () => {
    apiMocks.listSubscriptions.mockResolvedValue([]);
    apiMocks.createSubscription.mockResolvedValue({
      ...waferSub,
      id: "sub-2",
      entity_type: "device",
      action: "updated",
    });
    const user = userEvent.setup();
    render(<SubscriptionManager personId="me-1" />);

    await screen.findByText(/No subscriptions yet/);
    await user.selectOptions(screen.getByLabelText("Type"), "device");
    await user.selectOptions(screen.getByLabelText("Action"), "updated");
    await user.click(screen.getByRole("button", { name: "Subscribe" }));

    await waitFor(() =>
      expect(apiMocks.createSubscription).toHaveBeenCalledWith({
        person_id: "me-1",
        entity_type: "device",
        action: "updated",
      }),
    );
    expect(await screen.findByText("device updated")).toBeDefined();
  });
});
