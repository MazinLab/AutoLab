import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { countOpenReviewTasks, getWhoami } from "../api/client";
import { AppShell } from "./AppShell";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    countOpenReviewTasks: vi.fn(),
    getWhoami: vi.fn(),
  };
});

// The shell chrome widgets have their own tests and their own API traffic;
// keep this test about the shell itself.
vi.mock("../components/ActorPicker", () => ({
  ActorPicker: () => null,
}));
vi.mock("../components/OutboxIndicator", () => ({
  OutboxIndicator: () => null,
}));
vi.mock("../components/ThemeToggle", () => ({
  ThemeToggle: () => null,
}));

function renderShell() {
  return render(
    <MemoryRouter>
      <AppShell>
        <p>content</p>
      </AppShell>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(countOpenReviewTasks).mockResolvedValue(0);
  vi.mocked(getWhoami).mockResolvedValue({
    login: null,
    person: null,
    mapped: false,
    can_write: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AppShell API status line", () => {
  it("shows full access when the API allows writes", async () => {
    renderShell();
    expect(
      await screen.findByText("Connected — full access"),
    ).toBeDefined();
  });

  it("shows read only when writes are identity-gated", async () => {
    vi.mocked(getWhoami).mockResolvedValue({
      login: null,
      person: null,
      mapped: false,
      can_write: false,
    });
    renderShell();
    expect(await screen.findByText("Connected — read only")).toBeDefined();
  });

  it("shows offline when the API is unreachable", async () => {
    vi.mocked(getWhoami).mockRejectedValue(new Error("offline"));
    renderShell();
    expect(
      await screen.findByText("Offline — writes will queue"),
    ).toBeDefined();
  });
});

describe("AppShell queue badge", () => {
  it("shows the open review task count on the Queue nav item", async () => {
    vi.mocked(countOpenReviewTasks).mockResolvedValue(3);

    renderShell();

    const badge = await screen.findByText("3");
    expect(badge.className).toBe("nav-badge");
    const queueLink = screen.getByRole("link", { name: /Queue/ });
    expect(queueLink.contains(badge)).toBe(true);
  });

  it("hides the badge when there are no open review tasks", async () => {
    vi.mocked(countOpenReviewTasks).mockResolvedValue(0);

    renderShell();

    await waitFor(() => expect(countOpenReviewTasks).toHaveBeenCalled());
    expect(document.querySelector(".nav-badge")).toBeNull();
  });

  it("hides the badge when the count fetch fails", async () => {
    vi.mocked(countOpenReviewTasks).mockRejectedValue(new Error("offline"));

    renderShell();

    await waitFor(() => expect(countOpenReviewTasks).toHaveBeenCalled());
    expect(document.querySelector(".nav-badge")).toBeNull();
  });

  it("refreshes the count every 60 seconds and stops on unmount", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(countOpenReviewTasks).mockResolvedValue(2);

      const { unmount } = renderShell();
      expect(countOpenReviewTasks).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(countOpenReviewTasks).toHaveBeenCalledTimes(2);

      unmount();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(countOpenReviewTasks).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
