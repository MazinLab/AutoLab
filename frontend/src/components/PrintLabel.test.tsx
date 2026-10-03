import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Entity, type EntityTemplate } from "../api/client";
import { PrintLabel } from "./PrintLabel";
import { TemplateForm } from "./TemplateForm";

const apiMocks = vi.hoisted(() => ({
  createEntity: vi.fn(),
  getPrinters: vi.fn(),
  printLabel: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createEntity: apiMocks.createEntity,
    getPrinters: apiMocks.getPrinters,
    printLabel: apiMocks.printLabel,
  };
});

const wafer: Entity = {
  id: "01900000-0000-7000-8000-000000000101",
  accession: "W-2026-0101",
  entity_type: "wafer",
  name: "Print test wafer",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-19T08:00:00Z",
  updated_at: "2026-07-19T08:00:00Z",
  version: 0,
};

const waferTemplate: EntityTemplate = {
  name: "Wafer",
  entity_type: "wafer",
  fields: [],
  body: false,
};

beforeEach(() => {
  apiMocks.createEntity.mockReset().mockResolvedValue(wafer);
  apiMocks.getPrinters.mockReset().mockResolvedValue(["bench", "cleanroom"]);
  apiMocks.printLabel.mockReset().mockResolvedValue({
    printer: "bench",
    format: "qr",
  });
});

afterEach(() => {
  cleanup();
});

describe("PrintLabel", () => {
  it("explains when no printers are configured instead of vanishing", async () => {
    apiMocks.getPrinters.mockResolvedValue([]);
    render(<PrintLabel entityId={wafer.id} />);

    const hint = await screen.findByText("No label printers configured");
    expect(hint.title).toContain("AUTOLAB_PRINTERS");
    expect(screen.queryByRole("button", { name: "Print label" })).toBeNull();
  });

  it("renders nothing when the printer list cannot be loaded", async () => {
    apiMocks.getPrinters.mockRejectedValue(new Error("network down"));
    const { container } = render(<PrintLabel entityId={wafer.id} />);

    await waitFor(() => expect(apiMocks.getPrinters).toHaveBeenCalledOnce());

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("No label printers configured")).toBeNull();
  });

  it("prints with the selected printer and text-only format", async () => {
    const user = userEvent.setup();
    render(<PrintLabel entityId={wafer.id} />);

    await user.selectOptions(await screen.findByLabelText("Printer"), "cleanroom");
    await user.selectOptions(screen.getByLabelText("Format"), "text");
    await user.click(screen.getByRole("button", { name: "Print label" }));

    await waitFor(() => {
      expect(apiMocks.printLabel).toHaveBeenCalledWith(wafer.id, {
        printer: "cleanroom",
        labelFormat: "text",
      });
    });
    expect(await screen.findByText("Label sent to cleanroom.")).toBeTruthy();
  });
});

describe("TemplateForm automatic label printing", () => {
  it("auto-prints once via the default printer after an entity is created", async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<TemplateForm onCreated={onCreated} template={waferTemplate} />);

    await user.click(screen.getByRole("button", { name: "Create wafer" }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(wafer);
      expect(apiMocks.printLabel).toHaveBeenCalledOnce();
      expect(apiMocks.printLabel).toHaveBeenCalledWith(wafer.id);
    });
  });

  it("keeps the success screen visible and reports an auto-print failure", async () => {
    apiMocks.printLabel.mockRejectedValue(new Error("printer offline"));

    function CreationHarness() {
      const [created, setCreated] = useState(false);
      const [labelError, setLabelError] = useState<string | null>(null);
      return created ? (
        <div>
          <p>Creation complete</p>
          {labelError ? <p>{labelError}</p> : null}
        </div>
      ) : (
        <TemplateForm
          onCreated={() => setCreated(true)}
          onLabelError={setLabelError}
          template={waferTemplate}
        />
      );
    }

    const user = userEvent.setup();
    render(<CreationHarness />);
    await user.click(screen.getByRole("button", { name: "Create wafer" }));

    expect(await screen.findByText("Creation complete")).toBeTruthy();
    expect(
      await screen.findByText("label failed — reprint from the entity page"),
    ).toBeTruthy();
    expect(apiMocks.printLabel).toHaveBeenCalledOnce();
  });
});
