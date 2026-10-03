import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type Entity, type SearchResult } from "../../api/client";
import { QuickNotePage } from "./index";

const apiMocks = vi.hoisted(() => ({
  createEdge: vi.fn(),
  createEntity: vi.fn(),
  resolveAccession: vi.fn(),
  searchEntities: vi.fn(),
  uploadArtifact: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    createEdge: apiMocks.createEdge,
    createEntity: apiMocks.createEntity,
    resolveAccession: apiMocks.resolveAccession,
    searchEntities: apiMocks.searchEntities,
    uploadArtifact: apiMocks.uploadArtifact,
  };
});

const outboxMocks = vi.hoisted(() => ({
  enqueueCreate: vi.fn(),
}));

vi.mock("../../offline/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../offline/outbox")>();
  return {
    ...actual,
    enqueueCreate: outboxMocks.enqueueCreate,
  };
});

const createdNote: Entity = {
  id: "01900000-0000-7000-8000-000000000010",
  accession: "N-2026-0001",
  entity_type: "note",
  name: "Measured array",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-18T20:00:00Z",
  updated_at: "2026-07-18T20:00:00Z",
  version: 0,
};

const device: SearchResult = {
  id: "01900000-0000-7000-8000-000000000050",
  accession: "DEV-2026-0417",
  entity_type: "device",
  name: "Array 417",
};

const wafer: Entity = {
  id: "01900000-0000-7000-8000-000000000060",
  accession: "W-2026-0001",
  entity_type: "wafer",
  name: "First wafer",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-18T20:00:00Z",
  updated_at: "2026-07-18T20:00:00Z",
  version: 0,
};

function renderQuickNote(): void {
  render(
    <MemoryRouter>
      <QuickNotePage />
    </MemoryRouter>,
  );
}

function typeBody(value: string): HTMLTextAreaElement {
  const textarea = screen.getByLabelText("Markdown note") as HTMLTextAreaElement;
  fireEvent.change(textarea, {
    target: { selectionStart: value.length, value },
  });
  return textarea;
}

async function insertDeviceMention(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLTextAreaElement> {
  const textarea = screen.getByLabelText("Markdown note") as HTMLTextAreaElement;
  const draft = "Measured [[Array";
  fireEvent.change(textarea, {
    target: { selectionStart: draft.length, value: draft },
  });
  await user.click(await screen.findByRole("button", { name: /DEV-2026-0417/ }));
  return textarea;
}

beforeEach(() => {
  apiMocks.createEdge.mockReset().mockResolvedValue({ id: "edge-1" });
  apiMocks.createEntity.mockReset().mockResolvedValue(createdNote);
  apiMocks.resolveAccession.mockReset().mockResolvedValue({ data: wafer, etag: null });
  apiMocks.searchEntities.mockReset().mockResolvedValue([device]);
  apiMocks.uploadArtifact.mockReset().mockResolvedValue({
    ...createdNote,
    id: "01900000-0000-7000-8000-0000000000aa",
    accession: "ART-2026-0001",
    entity_type: "artifact",
  });
  outboxMocks.enqueueCreate.mockReset().mockImplementation(
    (entityType: string, payload: Record<string, unknown>) => ({
      id: "queued-1",
      entityType,
      payload,
      queuedAt: "2026-08-08T10:00:00Z",
    }),
  );
});

afterEach(() => {
  cleanup();
});

describe("QuickNotePage entity references", () => {
  it("persists selected mentions as refers_to links in the create payload", async () => {
    const user = userEvent.setup();
    renderQuickNote();
    await insertDeviceMention(user);

    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("note", {
        source_key: expect.stringMatching(/^web:/),
        name: "Measured [[DEV-2026-0417]]",
        body: "Measured [[DEV-2026-0417]]",
        links: [{ relation: "refers_to", dst_id: device.id }],
      });
    });
    // Autocomplete picks are already resolved; no lookup, no post-create edges.
    expect(apiMocks.resolveAccession).not.toHaveBeenCalled();
    expect(apiMocks.createEdge).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: device.accession }).getAttribute("href")).toBe(
      `/e/${device.accession}`,
    );
  });

  it("resolves a manually typed [[accession]] into a refers_to link", async () => {
    const user = userEvent.setup();
    renderQuickNote();
    typeBody("Etched [[W-2026-0001]] in the ICP");

    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("note", {
        source_key: expect.stringMatching(/^web:/),
        name: "Etched [[W-2026-0001]] in the ICP",
        body: "Etched [[W-2026-0001]] in the ICP",
        links: [{ relation: "refers_to", dst_id: wafer.id }],
      });
    });
    expect(apiMocks.resolveAccession).toHaveBeenCalledWith("W-2026-0001");
    expect(apiMocks.createEdge).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: wafer.accession }).getAttribute("href")).toBe(
      `/e/${wafer.accession}`,
    );
  });

  it("names an unknown [[accession]] in an error and creates nothing", async () => {
    const user = userEvent.setup();
    apiMocks.resolveAccession.mockRejectedValue(new ApiError(404, "Not Found"));
    renderQuickNote();
    typeBody("Broke [[W-2099-9999]] somehow");

    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(
      (await screen.findByText(/does not match any catalog record/)).textContent,
    ).toContain("[[W-2099-9999]]");
    expect(apiMocks.createEntity).not.toHaveBeenCalled();
    expect(apiMocks.createEdge).not.toHaveBeenCalled();
  });

  it("shows the create error and keeps the draft when the atomic create fails", async () => {
    const user = userEvent.setup();
    apiMocks.createEntity
      .mockRejectedValueOnce(new ApiError(503, "database temporarily unavailable"))
      .mockResolvedValue(createdNote);
    renderQuickNote();
    const textarea = await insertDeviceMention(user);

    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(
      (await screen.findByText(/database temporarily unavailable/)).textContent,
    ).toContain(
      "database temporarily unavailable",
    );
    // Atomic create failed: nothing was persisted, the draft survives.
    expect(textarea.value).toBe("Measured [[DEV-2026-0417]]");
    expect(apiMocks.createEdge).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      expect(screen.getByText(/Created N-2026-0001/)).toBeTruthy();
    });
    expect(apiMocks.createEntity).toHaveBeenCalledTimes(2);
    // The retry is the SAME logical note: identical source_key, so a create
    // that silently committed on the first try cannot duplicate.
    const [firstCall, secondCall] = apiMocks.createEntity.mock.calls;
    expect((secondCall[1] as { source_key: string }).source_key).toBe(
      (firstCall[1] as { source_key: string }).source_key,
    );
  });

  it("does not link a selected mention after the token is removed", async () => {
    const user = userEvent.setup();
    renderQuickNote();
    const textarea = await insertDeviceMention(user);
    fireEvent.change(textarea, {
      target: { selectionStart: 12, value: "No reference" },
    });

    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("note", {
        source_key: expect.stringMatching(/^web:/),
        name: "No reference",
        body: "No reference",
      });
    });
    expect(apiMocks.createEdge).not.toHaveBeenCalled();
  });
});

describe("QuickNotePage attachments", () => {
  it("uploads attachments after the create, linked to the new note", async () => {
    const user = userEvent.setup();
    renderQuickNote();
    typeBody("Cooldown photo log");
    const photo = new File(["png-bytes"], "bench.png", { type: "image/png" });
    const sweep = new File(["h5-bytes"], "sweep.h5", {
      type: "application/x-hdf5",
    });
    await user.upload(screen.getByLabelText("Take a photo to attach"), photo);
    await user.upload(screen.getByLabelText("Attach files"), sweep);

    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      expect(screen.getByText(/Created N-2026-0001/)).toBeTruthy();
    });
    expect(apiMocks.uploadArtifact).toHaveBeenCalledTimes(2);
    expect(apiMocks.uploadArtifact).toHaveBeenCalledWith(photo, {
      linkEntityId: createdNote.id,
      relation: "annotates",
    });
    expect(apiMocks.uploadArtifact).toHaveBeenCalledWith(sweep, {
      linkEntityId: createdNote.id,
      relation: "annotates",
    });
    // The create itself must not have been called with the files.
    const createCall = apiMocks.createEntity.mock.calls[0];
    expect(createCall[0]).toBe("note");
    expect(createCall[1]).toEqual({
      name: "Cooldown photo log",
      body: "Cooldown photo log",
      source_key: expect.stringMatching(/^web:/),
    });
  });

  it("keeps the created note and names the files whose upload failed", async () => {
    const user = userEvent.setup();
    apiMocks.uploadArtifact
      .mockRejectedValueOnce(new ApiError(500, "storage unavailable"))
      .mockResolvedValue({
        ...createdNote,
        id: "01900000-0000-7000-8000-0000000000ab",
        accession: "ART-2026-0002",
        entity_type: "artifact",
      });
    renderQuickNote();
    typeBody("Two files, one bad");
    const bad = new File(["a"], "bad.png", { type: "image/png" });
    const good = new File(["b"], "good.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Attach files"), [bad, good]);

    await user.click(screen.getByRole("button", { name: "Save note" }));

    // The note survives; the failure message names exactly the lost file.
    await waitFor(() => {
      expect(screen.getByText(/Created N-2026-0001/)).toBeTruthy();
    });
    const failure = await screen.findByText(/failed to upload/);
    expect(failure.textContent).toContain("bad.png");
    expect(failure.textContent).not.toContain("good.png");
    expect(apiMocks.uploadArtifact).toHaveBeenCalledTimes(2);
  });

  it("warns that attachments were dropped when the note is queued offline", async () => {
    const user = userEvent.setup();
    apiMocks.createEntity.mockRejectedValue(new TypeError("Failed to fetch"));
    renderQuickNote();
    typeBody("Offline note");
    const photo = new File(["png"], "offline.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Take a photo to attach"), photo);

    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(
      await screen.findByText(/the note is queued and will sync/),
    ).toBeTruthy();
    expect(
      await screen.findByText(/Attachments cannot be queued offline/),
    ).toBeTruthy();
    expect(apiMocks.uploadArtifact).not.toHaveBeenCalled();
    // The camera shot is NOT discarded: it stays selected for later upload.
    expect(screen.getByText("offline.png")).toBeTruthy();
    // The queued payload carries the same source_key the direct POST used,
    // so a create that silently committed replays as a no-op.
    const postedKey = (
      apiMocks.createEntity.mock.calls[0][1] as { source_key: string }
    ).source_key;
    expect(postedKey).toMatch(/^web:/);
    expect(outboxMocks.enqueueCreate).toHaveBeenCalledWith("note", {
      name: "Offline note",
      body: "Offline note",
      source_key: postedKey,
    });
  });

  it("keeps the draft and shows an error when the offline queue fails", async () => {
    const user = userEvent.setup();
    apiMocks.createEntity.mockRejectedValue(new TypeError("Failed to fetch"));
    outboxMocks.enqueueCreate.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    renderQuickNote();
    const textarea = typeBody("Unqueueable note");
    const photo = new File(["png"], "keep-me.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Take a photo to attach"), photo);

    await user.click(screen.getByRole("button", { name: "Save note" }));

    // No false "queued" reassurance, and the whole draft survives.
    expect(await screen.findByText(/could not be queued/)).toBeTruthy();
    expect(screen.queryByText(/queued and will sync/)).toBeNull();
    expect(textarea.value).toBe("Unqueueable note");
    expect(screen.getByText("keep-me.png")).toBeTruthy();
  });

  it("retries only the failed uploads against the created note", async () => {
    const user = userEvent.setup();
    apiMocks.uploadArtifact
      .mockRejectedValueOnce(new ApiError(500, "storage unavailable"))
      .mockResolvedValue({
        ...createdNote,
        id: "01900000-0000-7000-8000-0000000000ac",
        accession: "ART-2026-0003",
        entity_type: "artifact",
      });
    renderQuickNote();
    typeBody("One bad upload");
    const bad = new File(["a"], "bad.png", { type: "image/png" });
    const good = new File(["b"], "good.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Attach files"), [bad, good]);

    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      expect(screen.getByText(/Created N-2026-0001/)).toBeTruthy();
    });
    // Only the failed file stays selected, with its error and a Remove
    // control; the uploaded one is gone.
    expect(screen.getByText("bad.png")).toBeTruthy();
    expect(screen.getByText("storage unavailable")).toBeTruthy();
    expect(screen.queryByText("good.png")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove bad.png" }),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Retry failed uploads" }),
    );

    await waitFor(() => {
      expect(apiMocks.uploadArtifact).toHaveBeenCalledTimes(3);
    });
    // The retry targets the already-created note; no second note is made.
    expect(apiMocks.createEntity).toHaveBeenCalledTimes(1);
    expect(apiMocks.uploadArtifact).toHaveBeenLastCalledWith(bad, {
      linkEntityId: createdNote.id,
      relation: "annotates",
    });
    await waitFor(() => {
      expect(screen.queryByText("bad.png")).toBeNull();
    });
  });

  it("locks the attachment inputs while a submission is in flight", async () => {
    const user = userEvent.setup();
    let releaseUpload: (() => void) | undefined;
    apiMocks.uploadArtifact.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseUpload = () =>
            resolve({
              ...createdNote,
              id: "01900000-0000-7000-8000-0000000000ad",
              accession: "ART-2026-0004",
              entity_type: "artifact",
            });
        }),
    );
    renderQuickNote();
    typeBody("Slow upload");
    const photo = new File(["png"], "slow.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Take a photo to attach"), photo);

    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      expect(
        (screen.getByLabelText("Attach files") as HTMLInputElement).disabled,
      ).toBe(true);
    });
    expect(
      (screen.getByLabelText("Take a photo to attach") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Remove slow.png" }) as
        HTMLButtonElement).disabled,
    ).toBe(true);

    releaseUpload?.();
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Attach files") as HTMLInputElement).disabled,
      ).toBe(false);
    });
  });
});

describe("QuickNotePage markdown preview", () => {
  it("previews the markdown body and keeps the draft when switching back", async () => {
    const user = userEvent.setup();
    renderQuickNote();
    typeBody("## Bias point\nSet to **-78 dBm**.");

    await user.click(screen.getByRole("button", { name: "Preview" }));

    expect(
      screen.getByRole("heading", { level: 2, name: "Bias point" }),
    ).toBeDefined();
    expect(screen.getByText("-78 dBm").tagName).toBe("STRONG");

    await user.click(screen.getByRole("button", { name: "Write" }));
    const textarea = screen.getByLabelText("Markdown note") as HTMLTextAreaElement;
    expect(textarea.value).toBe("## Bias point\nSet to **-78 dBm**.");
  });
});
