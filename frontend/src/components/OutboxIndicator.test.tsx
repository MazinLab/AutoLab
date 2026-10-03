import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { OutboxIndicator } from "./OutboxIndicator";

const DEAD_KEY = "autolab.outbox.dead";

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

function seedDeadLetters(): void {
  window.localStorage.setItem(
    DEAD_KEY,
    JSON.stringify([
      {
        entry: {
          id: "dead-1",
          entityType: "note",
          payload: { name: "Cooldown observations", body: "He3 pot ran dry" },
          queuedAt: "2026-08-01T10:00:00Z",
          actorId: null,
        },
        detail: "missing required fields",
        deadLetteredAt: "2026-08-01T12:00:00Z",
      },
    ]),
  );
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
});

describe("OutboxIndicator dead letters", () => {
  it("renders nothing when there is no pending or dead-lettered work", () => {
    const { container } = render(<OutboxIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the dead-lettered count with the entry name and error", () => {
    seedDeadLetters();
    render(<OutboxIndicator />);

    expect(
      screen.getByText(/1 queued record was rejected by the server/),
    ).toBeTruthy();
    expect(screen.getByText("Cooldown observations")).toBeTruthy();
    expect(screen.getByText("missing required fields")).toBeTruthy();
  });

  it("copies a readable payload dump to the clipboard", async () => {
    seedDeadLetters();
    // userEvent.setup() installs its own clipboard stub; override it after.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<OutboxIndicator />);

    await user.click(screen.getByRole("button", { name: "Copy text" }));

    expect(writeText).toHaveBeenCalledOnce();
    const dump = writeText.mock.calls[0][0] as string;
    expect(dump).toContain("name: Cooldown observations");
    expect(dump).toContain("body: He3 pot ran dry");
    expect(dump).toContain("missing required fields");
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toBeTruthy();
  });

  it("discards a dead-lettered entry on tap", async () => {
    seedDeadLetters();
    const user = userEvent.setup();
    const { container } = render(<OutboxIndicator />);

    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(container.firstChild).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(DEAD_KEY) ?? "[]")).toEqual(
      [],
    );
  });
});
