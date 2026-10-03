import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACTOR_STORAGE_KEY,
  ApiError,
  createEntity,
  getEntity,
  getEntityEvents,
  getEntityLabel,
  getEvents,
  getLineageGraph,
  getPrinters,
  getRegistry,
  parseAccessionUrl,
  patchEntity,
  printLabel,
  resolveAccession,
  searchEntities,
  type Entity,
} from "./client";

const entity: Entity = {
  id: "01900000-0000-7000-8000-000000000001",
  accession: "W-2026-0001",
  entity_type: "wafer",
  name: "Test wafer",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-18T20:00:00Z",
  updated_at: "2026-07-18T20:00:00Z",
  version: 1,
};

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

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

function mockedFetch(response: Response): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("entity requests", () => {
  it("posts JSON and supplies the configured actor header", async () => {
    window.localStorage.setItem(
      ACTOR_STORAGE_KEY,
      "01900000-0000-7000-8000-000000000099",
    );
    const fetchMock = mockedFetch(jsonResponse(entity, { status: 201 }));

    await expect(createEntity("wafer", { name: "Test wafer" })).resolves.toEqual(entity);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(path).toBe("/api/wafer");
    expect(init?.method).toBe("POST");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Actor-Id")).toBe(
      "01900000-0000-7000-8000-000000000099",
    );
    expect(init?.body).toBe(JSON.stringify({ name: "Test wafer" }));
  });

  it("sends a per-call actor override instead of the stored actor", async () => {
    window.localStorage.setItem(
      ACTOR_STORAGE_KEY,
      "01900000-0000-7000-8000-000000000099",
    );
    const fetchMock = mockedFetch(jsonResponse(entity, { status: 201 }));

    await createEntity(
      "wafer",
      { name: "Test wafer" },
      { actorId: "01900000-0000-7000-8000-000000000042" },
    );

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("X-Actor-Id")).toBe(
      "01900000-0000-7000-8000-000000000042",
    );
  });

  it("omits the actor header entirely when the override is null", async () => {
    window.localStorage.setItem(
      ACTOR_STORAGE_KEY,
      "01900000-0000-7000-8000-000000000099",
    );
    const fetchMock = mockedFetch(jsonResponse(entity, { status: 201 }));

    await createEntity("wafer", { name: "Test wafer" }, { actorId: null });

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.has("X-Actor-Id")).toBe(false);
  });

  it("captures an ETag and sends it back with a patch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(entity, { headers: { ETag: '"v1"' } }))
      .mockResolvedValueOnce(
        jsonResponse(
          { ...entity, name: "Renamed wafer", version: 2 },
          { headers: { ETag: '"v2"' } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await getEntity("wafer", entity.id);
    const updated = await patchEntity(
      "wafer",
      entity.id,
      { name: "Renamed wafer" },
      loaded.etag ?? undefined,
    );

    expect(loaded.etag).toBe('"v1"');
    expect(updated.etag).toBe('"v2"');
    const patchHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/wafer/${entity.id}`);
    expect(patchHeaders.get("If-Match")).toBe('"v1"');
  });

  it("omits If-Match when no ETag is supplied", async () => {
    const fetchMock = mockedFetch(jsonResponse(entity));

    await patchEntity("wafer", entity.id, { description: "updated" });

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.has("If-Match")).toBe(false);
  });

  it("raises an ApiError with FastAPI detail", async () => {
    mockedFetch(jsonResponse({ detail: "stale entity version" }, { status: 412 }));

    const request = patchEntity("wafer", entity.id, { name: "stale" }, '"v0"');

    await expect(request).rejects.toMatchObject({
      status: 412,
      detail: "stale entity version",
    } satisfies Partial<ApiError>);
  });
});

describe("catalog query requests", () => {
  it("encodes search text and limits", async () => {
    const fetchMock = mockedFetch(jsonResponse([]));

    await searchEntities("wafer + cooldown", 12);

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/search?q=wafer+%2B+cooldown&limit=12",
    );
  });

  it("requests the graph lineage response explicitly", async () => {
    const fetchMock = mockedFetch(jsonResponse({ nodes: [], edges: [] }));

    await getLineageGraph(entity.id, { direction: "up", depth: 7 });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/entities/${entity.id}/lineage?direction=up&depth=7&graph=true`,
    );
  });

  it("requests both-direction related lineage with relation filters", async () => {
    const fetchMock = mockedFetch(jsonResponse({ nodes: [], edges: [] }));

    await getLineageGraph(entity.id, {
      direction: "both",
      depth: 1,
      relations: ["refers_to", "annotates"],
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/entities/${entity.id}/lineage?direction=both&depth=1&relations=refers_to%2Cannotates&graph=true`,
    );
  });

  it("loads registry metadata and an entity-scoped event page", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(entity))
      .mockResolvedValueOnce(jsonResponse({ events: [], next_cursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    await getRegistry("entity/id");
    await getEntityEvents("entity/id", {
      after: "2026-07-18T12:30:00+00:00|event-1",
      limit: 20,
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/entities/entity%2Fid/registry");
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/entities/entity%2Fid/events?after=2026-07-18T12%3A30%3A00%2B00%3A00%7Cevent-1&limit=20",
    );
  });

  it("loads the derived label and configured printer names", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ label: "Run.Wafer.Die" }))
      .mockResolvedValueOnce(jsonResponse(["bench", "cleanroom"]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getEntityLabel("entity/id")).resolves.toBe("Run.Wafer.Die");
    await expect(getPrinters()).resolves.toEqual(["bench", "cleanroom"]);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/entities/entity%2Fid/label");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/printers");
  });

  it("maps print options to the backend request body", async () => {
    const fetchMock = mockedFetch(
      jsonResponse({ printer: "cleanroom", format: "text" }),
    );

    await expect(
      printLabel("entity/id", {
        printer: "cleanroom",
        labelFormat: "text",
      }),
    ).resolves.toEqual({ printer: "cleanroom", format: "text" });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/entities/entity%2Fid/print-label",
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ printer: "cleanroom", label_format: "text" }),
    );
  });

  it("preserves event cursor punctuation through URLSearchParams", async () => {
    const fetchMock = mockedFetch(jsonResponse({ events: [], next_cursor: null }));

    await getEvents({ after: "2026-07-18T12:30:00+00:00|event-1", limit: 20 });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/events?after=2026-07-18T12%3A30%3A00%2B00%3A00%7Cevent-1&limit=20",
    );
  });

  it("encodes accessions used in resolver API paths", async () => {
    const fetchMock = mockedFetch(jsonResponse(entity, { headers: { ETag: '"v1"' } }));

    await resolveAccession("W 2026/0001");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/e/W%202026%2F0001");
  });
});

describe("parseAccessionUrl", () => {
  it.each([
    ["W-2026-0001", "W-2026-0001"],
    ["  DEV-2026-0417  ", "DEV-2026-0417"],
    ["/e/W-2026-0001", "W-2026-0001"],
    ["/e/W-2026-0001/?from=scan", "W-2026-0001"],
    ["https://lab.example/e/DEV-2026-0417#record", "DEV-2026-0417"],
    ["https://lab.example/e/W%202026%200001", "W 2026 0001"],
  ])("parses %s", (input, expected) => {
    expect(parseAccessionUrl(input)).toBe(expected);
  });

  it.each(["", "   ", "/queue", "https://lab.example/entity/123"])(
    "rejects non-accession input %s",
    (input) => {
      expect(parseAccessionUrl(input)).toBeNull();
    },
  );
});
