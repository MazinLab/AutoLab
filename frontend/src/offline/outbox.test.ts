import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACTOR_STORAGE_KEY, ApiError } from "../api/client";
import {
  deadLetteredCreates,
  discardDeadLetter,
  enqueueCreate,
  flushOutbox,
  isNetworkFailure,
  pendingCreates,
  type QueuedCreate,
} from "./outbox";

const apiMocks = vi.hoisted(() => ({ createEntity: vi.fn() }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, createEntity: apiMocks.createEntity };
});

const OUTBOX_KEY = "autolab.outbox";

class MemoryStorage implements Storage {
  protected readonly values = new Map<string, string>();

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

/** Quota-exceeded style storage: setItem throws. */
class ThrowingStorage extends MemoryStorage {
  override setItem(): void {
    throw new Error("QuotaExceededError");
  }
}

/** Private-mode shim style storage: setItem silently persists nothing. */
class SilentlyDroppingStorage extends MemoryStorage {
  override setItem(): void {
    // Discard the write without raising.
  }
}

function installStorage(storage: Storage): void {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

beforeEach(() => {
  installStorage(new MemoryStorage());
  apiMocks.createEntity.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("offline outbox", () => {
  it("classifies fetch failures as network, ApiError as server", () => {
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkFailure(new ApiError(422, "bad payload"))).toBe(false);
  });

  it("queues creates and replays them with a fallback idempotent source_key", async () => {
    apiMocks.createEntity.mockResolvedValue({});
    const entry = enqueueCreate("note", { name: "offline note", body: "x" });
    expect(pendingCreates()).toHaveLength(1);

    const result = await flushOutbox();

    expect(result).toEqual({ sent: 1, rejected: [], remaining: 0 });
    expect(pendingCreates()).toHaveLength(0);
    // No actor was selected at enqueue: replay must send no actor either.
    expect(apiMocks.createEntity).toHaveBeenCalledWith(
      "note",
      {
        name: "offline note",
        body: "x",
        source_key: `outbox:${entry.id}`,
      },
      { actorId: null },
    );
  });

  it("never overwrites a caller-supplied source_key at replay", async () => {
    apiMocks.createEntity.mockResolvedValue({});
    enqueueCreate("note", { name: "draft", source_key: "form:draft-abc" });

    await flushOutbox();

    expect(apiMocks.createEntity).toHaveBeenCalledWith(
      "note",
      { name: "draft", source_key: "form:draft-abc" },
      { actorId: null },
    );
  });

  it("replays with the actor captured at enqueue, not the one selected now", async () => {
    apiMocks.createEntity.mockResolvedValue({});
    window.localStorage.setItem(ACTOR_STORAGE_KEY, "actor-at-enqueue");
    enqueueCreate("note", { name: "authored note" });
    window.localStorage.setItem(ACTOR_STORAGE_KEY, "actor-at-replay");

    await flushOutbox();

    expect(apiMocks.createEntity).toHaveBeenCalledWith(
      "note",
      expect.objectContaining({ name: "authored note" }),
      { actorId: "actor-at-enqueue" },
    );
  });

  it("replays legacy entries without a captured actor using today's behavior", async () => {
    apiMocks.createEntity.mockResolvedValue({});
    const legacy: Omit<QueuedCreate, "actorId"> = {
      id: "legacy-1",
      entityType: "note",
      payload: { name: "old queued note" },
      queuedAt: "2026-07-01T00:00:00Z",
    };
    window.localStorage.setItem(OUTBOX_KEY, JSON.stringify([legacy]));

    await flushOutbox();

    expect(apiMocks.createEntity).toHaveBeenCalledWith(
      "note",
      expect.objectContaining({ name: "old queued note" }),
      {},
    );
  });

  it("keeps entries on network failure, dead-letters on 4xx", async () => {
    enqueueCreate("note", { name: "still offline" });
    enqueueCreate("note", { name: "invalid" });
    apiMocks.createEntity
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new ApiError(422, "missing required fields"));

    const result = await flushOutbox();

    expect(result.sent).toBe(0);
    expect(result.remaining).toBe(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].detail).toBe("missing required fields");
    expect(pendingCreates().map((entry) => entry.payload.name)).toEqual([
      "still offline",
    ]);
    // The rejected record is preserved durably, not silently dropped.
    const dead = deadLetteredCreates();
    expect(dead).toHaveLength(1);
    expect(dead[0].entry.payload.name).toBe("invalid");
    expect(dead[0].detail).toBe("missing required fields");
    expect(dead[0].deadLetteredAt).toBeTruthy();
  });

  it("caps the dead-letter list at 20, dropping the oldest", async () => {
    apiMocks.createEntity.mockRejectedValue(new ApiError(422, "nope"));
    for (let i = 1; i <= 21; i += 1) {
      enqueueCreate("note", { name: `reject-${i}` });
    }

    await flushOutbox();

    const dead = deadLetteredCreates();
    expect(dead).toHaveLength(20);
    expect(dead[0].entry.payload.name).toBe("reject-2");
    expect(dead[19].entry.payload.name).toBe("reject-21");
  });

  it("discards a single dead-lettered entry by id", async () => {
    apiMocks.createEntity.mockRejectedValue(new ApiError(409, "duplicate"));
    const kept = enqueueCreate("note", { name: "keep me" });
    const dropped = enqueueCreate("note", { name: "drop me" });
    await flushOutbox();
    expect(deadLetteredCreates()).toHaveLength(2);

    discardDeadLetter(dropped.id);

    const dead = deadLetteredCreates();
    expect(dead).toHaveLength(1);
    expect(dead[0].entry.id).toBe(kept.id);
  });

  it("keeps entries enqueued while a flush is in flight", async () => {
    let resolveCreate!: (value: unknown) => void;
    apiMocks.createEntity.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    enqueueCreate("note", { name: "first" });

    const flushPromise = flushOutbox();
    // The flush has snapshotted storage and is awaiting the network call;
    // a record authored right now must not be erased when it finishes.
    enqueueCreate("note", { name: "enqueued mid-flight" });
    resolveCreate({});
    const result = await flushPromise;

    expect(result.sent).toBe(1);
    expect(result.remaining).toBe(1);
    expect(pendingCreates().map((entry) => entry.payload.name)).toEqual([
      "enqueued mid-flight",
    ]);
  });

  it("throws from enqueueCreate when storage writes raise", () => {
    installStorage(new ThrowingStorage());

    expect(() => enqueueCreate("note", { name: "lost?" })).toThrow(
      /NOT queued/,
    );
  });

  it("throws from enqueueCreate when storage silently persists nothing", () => {
    installStorage(new SilentlyDroppingStorage());

    expect(() => enqueueCreate("note", { name: "lost?" })).toThrow(
      /NOT queued/,
    );
    expect(pendingCreates()).toHaveLength(0);
  });
});
