import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEdge,
  deleteEdge,
  deleteEntity,
  getEntity,
  getEntityEvents,
  getEntityLabel,
  getLineageGraph,
  getPrinters,
  getRegistry,
  resolveAccession,
  uploadArtifact,
  type Entity,
  type LineageGraph,
} from "../api/client";
import { EntityPage } from "./entity/EntityPage";

vi.mock("../api/client", async () => {
  const actual =
    await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    createEdge: vi.fn(),
    deleteEdge: vi.fn(),
    deleteEntity: vi.fn(),
    getEntity: vi.fn(),
    getEntityEvents: vi.fn(),
    getEntityLabel: vi.fn(),
    getLineageGraph: vi.fn(),
    getPrinters: vi.fn(),
    getRegistry: vi.fn(),
    resolveAccession: vi.fn(),
    uploadArtifact: vi.fn(),
  };
});

const wafer: Entity = {
  id: "01900000-0000-7000-8000-000000000001",
  accession: "W-2026-0001",
  entity_type: "wafer",
  name: "Science wafer",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-18T20:00:00Z",
  updated_at: "2026-07-18T20:00:00Z",
  version: 1,
};

const design: Entity = {
  ...wafer,
  id: "01900000-0000-7000-8000-000000000005",
  accession: "DSN-2026-0001",
  entity_type: "design",
  name: "U1 trilayer",
};

const emptyGraph: LineageGraph = { nodes: [], edges: [] };

function designGraph(): LineageGraph {
  return {
    nodes: [
      {
        id: design.id,
        entity_type: "design",
        accession: design.accession,
        depth: 1,
      },
    ],
    edges: [
      { src_id: wafer.id, relation: "derived_from", dst_id: design.id },
    ],
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/entity/${wafer.id}`]}>
      <Routes>
        <Route path="/entity/:id" element={<EntityPage />} />
        <Route path="/" element={<p>home after delete</p>} />
        <Route path="/notes/new" element={<p>quick note page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRegistry).mockResolvedValue({
    id: wafer.id,
    entity_type: "wafer",
    accession: wafer.accession,
    source_key: null,
    version: 1,
    created_at: wafer.created_at,
    updated_at: wafer.updated_at,
    created_by_id: null,
  });
  vi.mocked(getEntity).mockImplementation((entityType) =>
    Promise.resolve(
      entityType === "design"
        ? { data: design, etag: '"v1"' }
        : { data: wafer, etag: '"v1"' },
    ),
  );
  vi.mocked(getEntityLabel).mockResolvedValue("DSN-2026-0001.W1");
  vi.mocked(getPrinters).mockResolvedValue([]);
  vi.mocked(getEntityEvents).mockResolvedValue({
    events: [],
    next_cursor: null,
  });
  // Structural depth-1 graph carries the design edge; others empty.
  vi.mocked(getLineageGraph).mockImplementation((_id, query) =>
    Promise.resolve(
      query?.relations?.includes("derived_from")
        ? designGraph()
        : emptyGraph,
    ),
  );
  vi.mocked(deleteEdge).mockResolvedValue(undefined);
  vi.mocked(deleteEntity).mockResolvedValue(undefined);
  vi.mocked(uploadArtifact).mockResolvedValue({
    ...wafer,
    id: "01900000-0000-7000-8000-000000000009",
    entity_type: "artifact",
  });
});

afterEach(cleanup);

// Safari empties the input's FileList object in place when a handler clears
// the input's value (WebKit FileInputType::setValue); jsdom does not. Emulate
// it so a handler that reads the list lazily sees it empty, as on an iPhone.
function safariPick(input: HTMLElement, files: File[]): void {
  const live = [...files];
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => live,
  });
  Object.defineProperty(input, "value", {
    configurable: true,
    get: () => (live.length > 0 ? live[0].name : ""),
    set: () => {
      live.length = 0;
    },
  });
  fireEvent.change(input);
}

describe("EntityPage corrections", () => {
  it("attaches an uploaded file to the record", async () => {
    const user = userEvent.setup();
    renderPage();
    const fileInput = (await screen.findByLabelText(
      "Attach files to this record",
    )) as HTMLInputElement;

    const file = new File([new Uint8Array([1, 2, 3])], "sweep.png", {
      type: "image/png",
    });
    await user.upload(fileInput, file);
    await user.click(screen.getByRole("button", { name: "Attach" }));

    await waitFor(() => {
      expect(uploadArtifact).toHaveBeenCalledWith(file, {
        linkEntityId: wafer.id,
        relation: "annotates",
      });
    });
  });

  it("keeps a photo and then files picked in turn on Safari", async () => {
    const user = userEvent.setup();
    renderPage();
    const photoInput = await screen.findByLabelText("Take a photo to attach");
    const shot = new File([new Uint8Array([1])], "IMG_9206.jpeg", {
      type: "image/jpeg",
    });
    const data = new File([new Uint8Array([2])], "W-2026-0006.RsM", {
      type: "application/octet-stream",
    });
    safariPick(photoInput, [shot]);
    safariPick(screen.getByLabelText("Attach files to this record"), [data]);
    await user.click(screen.getByRole("button", { name: "Attach 2 files" }));

    await waitFor(() => {
      expect(uploadArtifact).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps failed uploads selected with their error for a retry", async () => {
    // First file fails, second succeeds; only the failure may stay selected.
    vi.mocked(uploadArtifact)
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValue({
        ...wafer,
        id: "01900000-0000-7000-8000-00000000000a",
        entity_type: "artifact",
      });
    const user = userEvent.setup();
    renderPage();
    const fileInput = (await screen.findByLabelText(
      "Attach files to this record",
    )) as HTMLInputElement;

    const bad = new File([new Uint8Array([1])], "bad.png", {
      type: "image/png",
    });
    const good = new File([new Uint8Array([2, 3])], "good.png", {
      type: "image/png",
    });
    await user.upload(fileInput, [bad, good]);
    await user.click(screen.getByRole("button", { name: "Attach 2 files" }));

    // The failed camera shot survives, listed with its error and a Remove
    // control; the uploaded file is gone from the selection.
    expect(await screen.findByText("bad.png")).toBeDefined();
    expect(screen.getByText("storage unavailable")).toBeDefined();
    expect(screen.queryByText("good.png")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove bad.png" }),
    ).toBeDefined();
    expect(screen.getByText(/Upload failed for: bad.png/)).toBeDefined();

    // Retry uploads only the failed file, against the same record.
    await user.click(
      screen.getByRole("button", { name: "Retry failed uploads" }),
    );
    await waitFor(() => {
      expect(uploadArtifact).toHaveBeenCalledTimes(3);
    });
    expect(vi.mocked(uploadArtifact).mock.calls[2][0]).toBe(bad);
    await waitFor(() => {
      expect(screen.queryByText("bad.png")).toBeNull();
    });
  });

  it("adds a link by accession", async () => {
    vi.mocked(resolveAccession).mockResolvedValue({
      data: design,
      etag: '"v1"',
    });
    vi.mocked(createEdge).mockResolvedValue({ id: "edge-1" });
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "+ Add link" }),
    );
    await user.selectOptions(
      screen.getByLabelText("Relation"),
      "refers_to",
    );
    await user.type(
      screen.getByLabelText("Target accession"),
      "DSN-2026-0001",
    );
    await user.click(screen.getByRole("button", { name: "Link" }));

    await waitFor(() => {
      expect(createEdge).toHaveBeenCalledWith({
        src_id: wafer.id,
        relation: "refers_to",
        dst_id: design.id,
      });
    });
  });

  it("unlinks a related record after a two-step confirm", async () => {
    renderPage();

    const unlink = await screen.findByRole("button", { name: "Unlink" });
    fireEvent.click(unlink);
    expect(deleteEdge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm unlink" }));

    await waitFor(() => {
      expect(deleteEdge).toHaveBeenCalledWith({
        src_id: wafer.id,
        relation: "derived_from",
        dst_id: design.id,
      });
    });
  });

  it("deletes the record after a two-step confirm and navigates home", async () => {
    renderPage();

    const remove = await screen.findByRole("button", {
      name: "Delete this record",
    });
    fireEvent.click(remove);
    expect(deleteEntity).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Permanently delete this record" }),
    );

    await waitFor(() => {
      expect(deleteEntity).toHaveBeenCalledWith("wafer", wafer.id);
      expect(screen.getByText("home after delete")).toBeDefined();
    });
  });

  it("shows a 409 explanation when deletion is refused", async () => {
    const { ApiError } = await vi.importActual<
      typeof import("../api/client")
    >("../api/client");
    vi.mocked(deleteEntity).mockRejectedValue(
      new ApiError(409, "cannot delete an actor with recorded activity"),
    );
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete this record" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Permanently delete this record" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("cannot delete an actor with recorded activity"),
      ).toBeDefined();
    });
  });
});
