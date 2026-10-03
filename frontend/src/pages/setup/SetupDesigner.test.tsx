import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  type Entity,
  type Layout,
  type LayoutEvaluation,
  type RfLibrary,
} from "../../api/client";
import { defaultLayout } from "./rfLayout";
import { SetupDesigner } from "./SetupDesigner";

const apiMocks = vi.hoisted(() => ({
  evaluateLayout: vi.fn(),
  getEntity: vi.fn(),
  getRfParts: vi.fn(),
  getSetupLayout: vi.fn(),
  getWhoami: vi.fn(),
  listAllEntities: vi.fn(),
  listEntities: vi.fn(),
  patchEntity: vi.fn(),
  putSetupLayout: vi.fn(),
  searchEntities: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, ...apiMocks };
});

const library: RfLibrary = {
  version: 1,
  parts: [
    { id: "attenuator_20db", label: "20 dB attenuator", category: "attenuator", symbol: "attenuator", gain_db: -20, noise_temp_k: null, ports: 0, bindable: false, directions: ["input"], default_stage: "4k" },
    { id: "isolator", label: "Isolator", category: "isolator", symbol: "isolator", gain_db: -0.3, noise_temp_k: null, ports: 0, bindable: false, directions: ["input", "output"], default_stage: "mxc" },
    { id: "coax_nbti", label: "NbTi coax", category: "coax", symbol: "coax", gain_db: -0.2, noise_temp_k: null, ports: 0, bindable: false, directions: ["input", "output"], default_stage: "still" },
    { id: "hemt", label: "HEMT amplifier", category: "amplifier", symbol: "amplifier", gain_db: 38, noise_temp_k: 2, ports: 0, bindable: true, directions: ["output"], default_stage: "4k" },
    { id: "switch_6way", label: "Six way RF switch", category: "switch", symbol: "switch", gain_db: -0.5, noise_temp_k: null, ports: 6, bindable: false, directions: ["input", "output"], default_stage: "4k" },
  ],
};

const setup: Entity = {
  id: "setup-1",
  accession: "ES-2026-0001",
  entity_type: "experiment_setup",
  name: "Cooldown 4",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-01T10:00:00Z",
  version: 3,
  base_temp_mk: 13,
};

const testbed: Entity = {
  ...setup,
  id: "fridge-1",
  accession: "INST-2026-0001",
  entity_type: "instrument",
  name: "Blue Fridge",
  kind: "dilution_refrigerator",
  category: "testbed",
  extra: { base_temp_mk: 60 },
  default_layout: {},
};

function evaluation(gain: number): LayoutEvaluation {
  return {
    evaluator_version: 1,
    library_version: 1,
    frequency_ghz: 6,
    convention: "classical",
    assumptions: [],
    feedlines: {
      A: {
        input: { active: true, chain_path: ["in1"], attenuation_db: 60, noise_temp_at_device_k: 0.028, parts: [] },
        output: { active: true, chain_path: ["out1"], gain_db: gain, added_noise_k: 2.29, parts: [] },
      },
    },
    warnings: [{ part: "out1-c", message: "HEMT amplifier is not bound to an instrument; library values used" }],
  };
}

function renderDesigner(): void {
  render(
    <MemoryRouter>
      <SetupDesigner setup={setup} testbedId={testbed.id} />
    </MemoryRouter>,
  );
}

const saved: Layout = defaultLayout("dilution_refrigerator", 0.013);

beforeEach(() => {
  window.sessionStorage.clear();
  apiMocks.getRfParts.mockReset().mockResolvedValue(library);
  apiMocks.getSetupLayout.mockReset().mockResolvedValue({
    data: { layout: saved, evaluation: evaluation(37.5), saved_evaluation: evaluation(37.5) },
    etag: '"v3"',
  });
  apiMocks.getWhoami.mockReset().mockResolvedValue({ login: "ben", person: null, mapped: true, can_write: true });
  apiMocks.getEntity.mockReset().mockResolvedValue({ data: testbed, etag: '"v1"' });
  apiMocks.evaluateLayout.mockReset().mockResolvedValue(evaluation(37.5));
  apiMocks.putSetupLayout.mockReset();
  apiMocks.patchEntity.mockReset().mockResolvedValue({ data: testbed, etag: '"v2"' });
  apiMocks.listAllEntities.mockReset().mockResolvedValue([]);
  apiMocks.listEntities.mockReset().mockResolvedValue([
    { ...setup, id: "dev-1", accession: "DEV-2026-0004", entity_type: "device", name: "AB chip 4" },
  ]);
  apiMocks.searchEntities.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("SetupDesigner", () => {
  it("renders the saved layout, results, and warnings", async () => {
    renderDesigner();
    const schematic = await screen.findByRole("img", { name: "Setup schematic" });
    expect(within(schematic).getByLabelText("HEMT amplifier at 4k")).toBeTruthy();
    expect(screen.getByText("37.5 dB")).toBeTruthy();
    expect(screen.getByText(/not bound to an instrument/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save layout" }).hasAttribute("disabled")).toBe(true);
  });

  it("adds a part by drop, marks results stale, evaluates, and saves with the ETag", async () => {
    apiMocks.evaluateLayout.mockResolvedValue(evaluation(37.2));
    apiMocks.putSetupLayout.mockResolvedValue({
      data: { layout: saved, evaluation: evaluation(37.2), saved_evaluation: evaluation(37.2) },
      etag: '"v4"',
    });
    const user = userEvent.setup();
    renderDesigner();
    await screen.findByRole("img", { name: "Setup schematic" });
    const target = screen.getByLabelText("Drop target out1 4 K");
    fireEvent.drop(target, { dataTransfer: { getData: () => "isolator" } });
    expect(await screen.findByLabelText("Isolator at 4k")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/Stale/);
    await waitFor(() => expect(apiMocks.evaluateLayout).toHaveBeenCalledOnce());
    await screen.findByText("37.2 dB");
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save layout" }));
    await waitFor(() => expect(apiMocks.putSetupLayout).toHaveBeenCalledOnce());
    const [id, layout, etag] = apiMocks.putSetupLayout.mock.calls[0];
    expect(id).toBe("setup-1");
    expect(etag).toBe('"v3"');
    expect((layout as Layout).chains[1].parts.some((part) => part.type === "isolator")).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save layout" }).hasAttribute("disabled")).toBe(true),
    );
  });

  it("stacks a second part in an occupied cell when dropped on the part", async () => {
    renderDesigner();
    await screen.findByRole("img", { name: "Setup schematic" });
    fireEvent.drop(screen.getByLabelText("HEMT amplifier at 4k"), { dataTransfer: { getData: () => "hemt" } });
    await waitFor(() => expect(screen.getAllByLabelText("HEMT amplifier at 4k")).toHaveLength(2));
  });

  it("offers a chain that accepts the part when adding from the palette", async () => {
    const user = userEvent.setup();
    renderDesigner();
    await screen.findByRole("img", { name: "Setup schematic" });
    await user.click(screen.getByRole("button", { name: "Add HEMT amplifier to…" }));
    expect((screen.getByLabelText("Chain") as HTMLSelectElement).value).toBe("out1");
  });

  it("discards an evaluation that arrives for an older draft revision", async () => {
    let resolveFirst: (value: LayoutEvaluation) => void = () => {};
    apiMocks.evaluateLayout
      .mockImplementationOnce(() => new Promise<LayoutEvaluation>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(evaluation(30));
    renderDesigner();
    await screen.findByRole("img", { name: "Setup schematic" });
    fireEvent.drop(screen.getByLabelText("Drop target out1 4 K"), { dataTransfer: { getData: () => "isolator" } });
    await waitFor(() => expect(apiMocks.evaluateLayout).toHaveBeenCalledTimes(1));
    fireEvent.drop(screen.getByLabelText("Drop target out1 50 K"), { dataTransfer: { getData: () => "coax_nbti" } });
    await waitFor(() => expect(apiMocks.evaluateLayout).toHaveBeenCalledTimes(2));
    await screen.findByText("30.0 dB");
    resolveFirst(evaluation(99));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("99.0 dB")).toBeNull();
    expect(screen.getByText("30.0 dB")).toBeTruthy();
  });

  it("shows validation messages from a rejected evaluation", async () => {
    apiMocks.evaluateLayout.mockRejectedValue(new ApiError(422, "invalid layout: chain 'in1' needs a feedline label"));
    const user = userEvent.setup();
    renderDesigner();
    await screen.findByRole("img", { name: "Setup schematic" });
    await user.clear(screen.getByLabelText("Chain in1 feedline"));
    expect(await screen.findByText("chain 'in1' needs a feedline label")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/not valid/);
  });

  it("explains a stale save and restores a draft from sessionStorage", async () => {
    apiMocks.putSetupLayout.mockRejectedValue(new ApiError(412, "stale"));
    const user = userEvent.setup();
    renderDesigner();
    await screen.findByRole("img", { name: "Setup schematic" });
    fireEvent.drop(screen.getByLabelText("Drop target out1 4 K"), { dataTransfer: { getData: () => "isolator" } });
    await user.click(await screen.findByRole("button", { name: "Save layout" }));
    expect(await screen.findByText(/changed since you loaded it/)).toBeTruthy();
    expect(window.sessionStorage.getItem("autolab.setup-draft.setup-1")).toContain("isolator");
    cleanup();
    renderDesigner();
    expect(await screen.findByText(/Unsaved draft restored/)).toBeTruthy();
    expect(screen.getByLabelText("Isolator at 4k")).toBeTruthy();
  });

  it("binds a HEMT from the inspector and saves the testbed default with its ETag", async () => {
    apiMocks.listAllEntities.mockResolvedValue([
      { ...testbed, id: "hemt-1", accession: "INST-2026-0009", name: "LNF 3", kind: "HEMT", category: "experimental", extra: { gain_db: 40, noise_temp_k: 1 } },
    ]);
    const user = userEvent.setup();
    renderDesigner();
    await screen.findByRole("img", { name: "Setup schematic" });
    await user.click(screen.getByLabelText("HEMT amplifier at 4k"));
    const bind = screen.getByLabelText("Bound instrument") as HTMLSelectElement;
    fireEvent.focus(bind);
    await waitFor(() => expect(bind.options.length).toBe(2));
    await user.selectOptions(bind, "hemt-1");
    expect(screen.getByLabelText("HEMT amplifier at 4k").textContent).toContain("•");
    await user.click(screen.getByRole("button", { name: "Save as testbed default" }));
    await user.click(screen.getByRole("button", { name: "Confirm: replace testbed default" }));
    await waitFor(() => expect(apiMocks.patchEntity).toHaveBeenCalledOnce());
    const [type, id, patch, etag] = apiMocks.patchEntity.mock.calls[0];
    expect([type, id, etag]).toEqual(["instrument", "fridge-1", '"v1"']);
    expect(((patch as { default_layout: Layout }).default_layout.chains[1].parts[2]).instrument_id).toBe("hemt-1");
  });

  it("refuses to remove an occupied stage and adds a new one in order", async () => {
    const user = userEvent.setup();
    renderDesigner();
    await screen.findByRole("img", { name: "Setup schematic" });
    await user.click(screen.getByRole("button", { name: "Remove stage 4 K" }));
    expect(await screen.findByText(/Move or remove its 2 parts first/)).toBeTruthy();
    await user.type(screen.getByLabelText("New stage label"), "1 K");
    await user.type(screen.getByLabelText("New stage temperature (K)"), "1");
    await user.click(screen.getByRole("button", { name: "Add stage" }));
    const labels = screen.getAllByLabelText(/Stage .* label$/).map((input) => (input as HTMLInputElement).value);
    expect(labels).toEqual(["300 K", "50 K", "4 K", "1 K", "Still", "13 mK"]);
  });

  it("offers a start from default on an empty layout and hides controls for read only viewers", async () => {
    apiMocks.getSetupLayout.mockResolvedValue({ data: { layout: {}, evaluation: null, saved_evaluation: null }, etag: '"v3"' });
    const user = userEvent.setup();
    renderDesigner();
    await user.click(await screen.findByRole("button", { name: "Start from testbed default" }));
    // The testbed carries 60 mK but the setup's own 13 mK wins.
    expect(await screen.findByLabelText("Stage mxc label")).toHaveProperty("value", "13 mK");
    cleanup();
    apiMocks.getWhoami.mockResolvedValue({ login: null, person: null, mapped: false, can_write: false });
    apiMocks.getSetupLayout.mockResolvedValue({
      data: { layout: saved, evaluation: evaluation(37.5), saved_evaluation: evaluation(37.5) },
      etag: '"v3"',
    });
    renderDesigner();
    await screen.findByRole("img", { name: "Setup schematic" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save layout" })).toBeNull());
    expect(screen.queryByLabelText("Parts palette")).toBeNull();
    expect(screen.getByText("37.5 dB")).toBeTruthy();
  });

  it("binds a device to a feedline, shows its name on the drawing, and strips it from the testbed default", async () => {
    const user = userEvent.setup();
    renderDesigner();
    await screen.findByRole("img", { name: "Setup schematic" });
    const picker = (await screen.findByLabelText("Device on feedline A")) as HTMLSelectElement;
    await waitFor(() => expect(picker.options.length).toBe(3)); // none, through, dev-1
    await user.selectOptions(picker, "dev-1");
    const schematic = screen.getByRole("img", { name: "Setup schematic" });
    await waitFor(() => expect(within(schematic).getAllByText("AB chip 4").length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: "Save as testbed default" }));
    await user.click(screen.getByRole("button", { name: "Confirm: replace testbed default" }));
    await waitFor(() => expect(apiMocks.patchEntity).toHaveBeenCalledOnce());
    const patch = apiMocks.patchEntity.mock.calls[0][2] as { default_layout: Layout };
    expect(patch.default_layout.feedlines).toBeUndefined();
  });

  it("binds a through line, labels it on the drawing, and keeps it in the testbed default", async () => {
    const user = userEvent.setup();
    renderDesigner();
    await screen.findByRole("img", { name: "Setup schematic" });
    const picker = (await screen.findByLabelText("Device on feedline A")) as HTMLSelectElement;
    await user.selectOptions(picker, "through");
    const schematic = screen.getByRole("img", { name: "Setup schematic" });
    await waitFor(() => expect(within(schematic).getAllByText("Through").length).toBeGreaterThan(0));
    expect(screen.queryByLabelText("Open device on feedline A")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save as testbed default" }));
    await user.click(screen.getByRole("button", { name: "Confirm: replace testbed default" }));
    await waitFor(() => expect(apiMocks.patchEntity).toHaveBeenCalledOnce());
    const patch = apiMocks.patchEntity.mock.calls[0][2] as { default_layout: Layout };
    expect(patch.default_layout.feedlines).toEqual({ A: { device_id: "through" } });
  });

  it("adds a switch, then branches on one port and on all ports from the inspector", async () => {
    const user = userEvent.setup();
    renderDesigner();
    await screen.findByRole("img", { name: "Setup schematic" });
    await user.click(screen.getByRole("button", { name: "Add Six way RF switch to…" }));
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByLabelText("Six way RF switch at 4k"));
    const addButtons = screen.getAllByRole("button", { name: "add branch" });
    expect(addButtons).toHaveLength(5); // port 1 already carries the colder parts
    await user.click(addButtons[0]); // port 2
    expect(screen.getAllByRole("button", { name: "add branch" })).toHaveLength(4);
    expect(screen.getByLabelText("Chain in1-2 feedline")).toHaveProperty("value", "A2");
    await user.click(screen.getByRole("button", { name: "Add branches on all ports" }));
    expect(screen.queryAllByRole("button", { name: "add branch" })).toHaveLength(0);
    expect(screen.getByLabelText("Chain in1-6 feedline")).toHaveProperty("value", "A6");
  });
});
