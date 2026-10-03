import { describe, expect, it } from "vitest";

import type { Layout, RfPart } from "../../api/client";
import {
  activeChainIds,
  addAllBranches,
  addBranch,
  addChain,
  addPart,
  chainOrder,
  defaultLayout,
  insertionIndex,
  layoutGeometry,
  libraryById,
  movePart,
  removeChain,
  removePart,
  removeStage,
  renameChain,
  replicateBranchParts,
  setColdestStageTemp,
  setPartStage,
  updateStage,
} from "./rfLayout";

function part(overrides: Partial<RfPart> & { id: string }): RfPart {
  return {
    label: overrides.id,
    category: "attenuator",
    symbol: "attenuator",
    gain_db: -20,
    noise_temp_k: null,
    ports: 0,
    bindable: false,
    directions: ["input"],
    default_stage: "4k",
    ...overrides,
  };
}

const LIB = libraryById([
  part({ id: "attenuator_20db" }),
  part({ id: "isolator", category: "isolator", symbol: "isolator", gain_db: -0.3, directions: ["input", "output"] }),
  part({ id: "coax_nbti", category: "coax", symbol: "coax", gain_db: -0.2, directions: ["input", "output"] }),
  part({ id: "hemt", category: "amplifier", symbol: "amplifier", gain_db: 38, noise_temp_k: 2, bindable: true, directions: ["output"] }),
  part({ id: "switch_6way", category: "switch", symbol: "switch", gain_db: -0.5, ports: 6, directions: ["input", "output"] }),
  part({ id: "fiber_smf", category: "optical", symbol: "fiber", gain_db: null, directions: [], destination: "device" }),
  part({ id: "window_sapphire", category: "optical", symbol: "window", gain_db: null, directions: [] }),
]);

function fridge(): Layout {
  return defaultLayout("dilution_refrigerator", 0.02);
}

describe("layout edits", () => {
  it("inserts a part at the order preserving position on an input chain", () => {
    const layout = fridge();
    const chain = layout.chains[0];
    expect(insertionIndex(layout, chain, "still", LIB)).toBe(2); // after the 4 K and still parts
    expect(insertionIndex(layout, chain, "50k", LIB)).toBe(0);
    expect(insertionIndex(layout, chain, "rt", LIB)).toBe(0);
    const next = addPart(layout, "in1", LIB.get("attenuator_20db")!, "50k");
    expect(next.chains[0].parts[0].stage).toBe("50k");
    expect(next.chains[0].parts.map((p) => p.stage)).toEqual(["50k", "4k", "still", "mxc"]);
  });

  it("a new switch takes the colder parts onto a port 1 branch with the feedline", () => {
    let layout = fridge();
    layout = addPart(layout, "in1", LIB.get("switch_6way")!, "4k");
    const root = layout.chains[0];
    expect(root.parts.map((p) => p.type)).toEqual(["attenuator_20db", "switch_6way"]);
    expect(root.feedline).toBeUndefined();
    const branch = layout.chains[2];
    expect(branch).toMatchObject({ id: "in1-1", direction: "input", feedline: "A", label: "Port 1" });
    expect(branch.parts.map((p) => p.stage)).toEqual(["still", "mxc"]);
    expect(root.parts[1].ports).toEqual({ "1": "in1-1" });
    expect(root.parts[1].selected_port).toBe(1);
    // A second switch on the same chain is refused.
    expect(addPart(layout, "in1", LIB.get("switch_6way")!, "rt")).toBe(layout);
  });

  it("inserts on an output chain in cold to warm order and keeps a switch first", () => {
    let layout = fridge();
    layout = addPart(layout, "out1", LIB.get("switch_6way")!, "4k");
    // On an output the switch goes first; the colder isolator and coax
    // move to the branch, the 4 K HEMT stays after the switch.
    expect(layout.chains[1].parts.map((p) => p.type)).toEqual(["switch_6way", "hemt"]);
    expect(layout.chains[2].parts.map((p) => p.type)).toEqual(["isolator", "coax_nbti"]);
    layout = addPart(layout, "out1", LIB.get("isolator")!, "4k");
    expect(layout.chains[1].parts.map((p) => p.type)).toEqual(["switch_6way", "hemt", "isolator"]);
  });

  it("a new output pairs with the unpaired input before minting a letter", () => {
    let layout = addChain(fridge(), "input"); // B, no output yet
    expect(layout.chains[2].feedline).toBe("B");
    layout = addChain(layout, "output");
    expect(layout.chains[3].feedline).toBe("B");
    layout = addChain(layout, "output"); // nothing unpaired: new letter
    expect(layout.chains[4].feedline).toBe("C");
  });

  it("adds windows to the optical column and fibers to a feedline", () => {
    let layout = addPart(fridge(), "in1", LIB.get("window_sapphire")!, "4k");
    expect(layout.optical).toEqual([{ id: "o1", type: "window_sapphire", stage: "4k" }]);
    layout = addPart(layout, "in1", LIB.get("fiber_smf")!, "4k");
    expect(layout.optical[1]).toEqual({ id: "o2", type: "fiber_smf", stage: "mxc", feedline: "A" });
    const geometry = layoutGeometry(layout, LIB);
    expect(geometry.fibers).toHaveLength(1);
    expect(geometry.fibers[0].x).toBe(geometry.chains[0].x + 16);
    // A second fiber on the same feedline sits beside the first.
    const two = layoutGeometry(addPart(layout, "in1", LIB.get("fiber_smf")!, "4k"), LIB);
    expect(two.fibers.map((f) => f.x)).toEqual([geometry.chains[0].x + 16, geometry.chains[0].x + 30]);
    expect(geometry.opticalX).not.toBeNull(); // the window still has its column
  });

  it("moving across a stage boundary takes the neighbour's stage", () => {
    const layout = movePart(fridge(), "in1-a", 1, LIB); // 4k part swaps with the still part
    expect(layout.chains[0].parts.map((p) => [p.id, p.stage])).toEqual([
      ["in1-b", "still"], ["in1-a", "still"], ["in1-c", "mxc"],
    ]);
  });

  it("changing a stage re-inserts the part in order", () => {
    const layout = setPartStage(fridge(), "in1-c", "rt", LIB);
    expect(layout.chains[0].parts.map((p) => [p.id, p.stage])).toEqual([
      ["in1-c", "rt"], ["in1-a", "4k"], ["in1-b", "still"],
    ]);
  });

  it("adds a branch on a switch port and removes it with the chain", () => {
    let layout = addPart(fridge(), "in1", LIB.get("switch_6way")!, "4k");
    const sw = layout.chains[0].parts[1];
    layout = addBranch(layout, sw.id, 3);
    const branch = layout.chains[3];
    expect(branch).toMatchObject({ direction: "input", feedline: "A3" });
    expect(layout.chains[0].parts[1].ports).toEqual({ "1": "in1-1", "3": branch.id });
    expect(layout.chains[0].parts[1].selected_port).toBe(1);
    expect(activeChainIds(layout, LIB)).not.toContain(branch.id);
    layout = removeChain(layout, branch.id);
    expect(layout.chains).toHaveLength(3);
    expect(layout.chains[0].parts[1].ports).toEqual({ "1": "in1-1" });
  });

  it("removing a switch folds the selected branch back onto its chain and restores the feedline", () => {
    let layout = addPart(fridge(), "in1", LIB.get("switch_6way")!, "4k");
    const sw = layout.chains[0].parts[1];
    layout = addBranch(layout, sw.id, 3);
    layout = addPart(layout, "in1-1", LIB.get("fiber_smf")!, "mxc", "A3");
    expect(layout.optical[0].feedline).toBe("A3");
    expect(layout.chains[0].feedline).toBeUndefined();
    layout = removePart(layout, sw.id);
    expect(layout.chains.map((chain) => chain.id)).toEqual(["in1", "out1"]);
    expect(layout.chains[0].feedline).toBe("A");
    expect(layout.chains[0].parts.map((p) => p.id)).toEqual(["in1-a", "in1-b", "in1-c"]);
    // The fiber that pointed at the vanished branch label follows the chain's letter.
    expect(layout.optical[0].feedline).toBe("A");
  });

  it("fibers follow a feedline rename and retarget or vanish when their feedline disappears", () => {
    let layout = addChain(fridge(), "input");
    expect(layout.chains[2].feedline).toBe("B");
    layout = addPart(layout, "in2", LIB.get("fiber_smf")!, "mxc", "B");
    layout = removeChain(layout, "in2");
    expect(layout.optical[0].feedline).toBe("A");
    // Output 1 still carries A, so renaming only the input leaves the fiber alone.
    layout = renameChain(layout, "in1", { feedline: "X" });
    expect(layout.optical[0].feedline).toBe("A");
    layout = renameChain(layout, "out1", { feedline: "X" });
    expect(layout.optical[0].feedline).toBe("X");
    layout = removeChain(removeChain(layout, "in1"), "out1");
    expect(layout.optical).toEqual([]);
  });

  it("lists chains in drawing order: each root followed by its own ports", () => {
    let layout = addPart(fridge(), "in1", LIB.get("switch_6way")!, "mxc");
    layout = addPart(layout, "out1", LIB.get("switch_6way")!, "mxc");
    layout = addAllBranches(layout, layout.chains[0].parts[layout.chains[0].parts.length - 1].id, LIB);
    layout = addAllBranches(layout, layout.chains[1].parts[0].id, LIB);
    const order = chainOrder(layout, LIB);
    expect(order.map((entry) => `${entry.chain.direction}:${entry.chain.label}`)).toEqual([
      "input:Input 1", "input:Port 1", "input:Port 2", "input:Port 3", "input:Port 4", "input:Port 5", "input:Port 6",
      "output:Output 1", "output:Port 1", "output:Port 2", "output:Port 3", "output:Port 4", "output:Port 5", "output:Port 6",
    ]);
    expect(order.map((entry) => entry.depth)).toEqual([0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1]);
  });

  it("fills all ports, pairs output branches with the input labels, and replicates parts", () => {
    let layout = addPart(fridge(), "in1", LIB.get("switch_6way")!, "4k");
    layout = addAllBranches(layout, layout.chains[0].parts[1].id, LIB);
    const inputLabels = layout.chains
      .filter((c) => c.direction === "input" && c.feedline)
      .map((c) => c.feedline);
    expect(inputLabels).toEqual(["A", "A2", "A3", "A4", "A5", "A6"]);
    // Output side: the switch takes the isolator and coax to port 1 ("A"),
    // and the remaining ports reuse the input side's labels.
    layout = addPart(layout, "out1", LIB.get("switch_6way")!, "4k");
    layout = addAllBranches(layout, layout.chains[1].parts[0].id, LIB);
    const outputLabels = layout.chains
      .filter((c) => c.direction === "output" && c.feedline)
      .map((c) => c.feedline);
    expect(outputLabels).toEqual(["A", "A2", "A3", "A4", "A5", "A6"]);
    const port1 = layout.chains.find((c) => c.id === "in1-1")!;
    expect(port1.parts).toHaveLength(2);
    layout = replicateBranchParts(layout, port1.id);
    const siblings = layout.chains.filter((c) => c.direction === "input" && c.id !== "in1" && c.id !== port1.id);
    expect(siblings).toHaveLength(5);
    expect(siblings.every((c) => c.parts.map((p) => p.stage).join() === "still,mxc")).toBe(true);
    const ids = layout.chains.flatMap((c) => c.parts.map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves free text fridge kinds and leaves single stage layouts alone", () => {
    expect(defaultLayout("Dilution refriderator", 0.013).stages.map((s) => s.id)).toEqual([
      "rt", "50k", "4k", "still", "mxc",
    ]);
    expect(defaultLayout("ADR", 0.06).stages.map((s) => s.id)).toEqual(["rt", "50k", "4k", "adr1", "mxc"]);
    const probe = defaultLayout("probe station", null);
    expect(setColdestStageTemp(probe, 0.06).stages).toEqual([{ id: "rt", label: "300 K", temp_k: 300 }]);
  });

  it("refuses to remove an occupied stage and to break temperature order", () => {
    expect(removeStage(fridge(), "still")).toMatch(/Move or remove its 2 parts/);
    expect(typeof removeStage(fridge(), "50k")).toBe("object");
    expect(updateStage(fridge(), "50k", { temp_k: 500 })).toMatch(/decreasing/);
    const next = updateStage(fridge(), "50k", { temp_k: 40 });
    expect(typeof next).toBe("object");
  });
});

describe("geometry", () => {
  it("places parts in their stage bands and grows a band with occupancy", () => {
    const base = layoutGeometry(fridge(), LIB);
    const shieldBand = base.bands.find((band) => band.id === "50k")!;
    expect(shieldBand.height).toBe(56);
    const fourK = base.bands.find((band) => band.id === "4k")!;
    const inFourK = base.parts.find((p) => p.id === "in1-a")!;
    expect(inFourK.y).toBeGreaterThan(fourK.y);
    expect(inFourK.y).toBeLessThan(fourK.y + fourK.height);
    const crowded = addPart(addPart(fridge(), "in1", LIB.get("attenuator_20db")!, "50k"), "in1", LIB.get("attenuator_20db")!, "50k");
    const grown = layoutGeometry(crowded, LIB).bands.find((band) => band.id === "50k")!;
    expect(grown.height).toBe(56 + 40);
  });

  it("draws one device bar per feedline run and dims an unselected branch", () => {
    let layout = addPart(fridge(), "in1", LIB.get("switch_6way")!, "4k");
    const sw = layout.chains[0].parts[1];
    layout = addBranch(layout, sw.id, 2);
    const geometry = layoutGeometry(layout, LIB);
    // Branches sit right after their parent, before the next root, and
    // share the parent's column group as narrow sub columns.
    expect(geometry.chains.map((chain) => chain.id)).toEqual([
      "in1", layout.chains[2].id, layout.chains[3].id, "out1",
    ]);
    const root = geometry.chains[0];
    const [left, right] = [geometry.chains[1], geometry.chains[2]];
    expect(right.x - left.x).toBe(60); // two leaves in a 120 px group
    expect(root.x).toBe((left.x + right.x) / 2);
    const swPlacement = geometry.parts.find((p) => p.id === layout.chains[0].parts[1].id)!;
    expect(root.bottomY).toBe(swPlacement.y);
    expect(left.topY).toBe(swPlacement.y + 22);
    expect(geometry.parts.find((p) => p.chainId === left.id)?.compact).toBe(true);
    const leaves = geometry.chains.filter((chain) => chain.leaf).map((chain) => chain.id);
    expect(leaves).toEqual([layout.chains[2].id, layout.chains[3].id, "out1"]);
    // One device bar per run of same feedline columns: A (port 1 branch),
    // A2 (port 2 branch), A again (Output 1), with gaps between them.
    expect(geometry.devices.map((bar) => bar.feedline)).toEqual(["A", "A2", "A"]);
    expect(geometry.devices[0].x1).toBeLessThan(left.x);
    expect(geometry.devices[0].x2).toBeLessThan(geometry.devices[1].x1);
    expect(geometry.devices[1].x2).toBeLessThan(geometry.devices[2].x1);
    expect(geometry.devices[2].x2).toBeGreaterThan(geometry.chains[3].x);
    expect(geometry.deviceY).toBe(geometry.devices[0].y);
    expect(geometry.chains.find((chain) => chain.id === layout.chains[2].id)!.active).toBe(true);
    expect(geometry.chains.find((chain) => chain.id === layout.chains[3].id)!.active).toBe(false);
    expect(geometry.fans).toHaveLength(2);
  });

  it("stacks a branch's parts on the switch's own stage beside the switch, not on it", () => {
    // Output: switch at the base stage, then a coax dropped on the branch
    // (device side) at the same stage sits below the switch; a coax on
    // the parent at that stage sits above it.
    let layout = addPart(fridge(), "out1", LIB.get("switch_6way")!, "mxc");
    const sw = layout.chains[1].parts[0];
    const branchId = sw.ports!["1"];
    layout = addPart(layout, branchId, LIB.get("coax_nbti")!, "mxc");
    layout = addPart(layout, "out1", LIB.get("coax_nbti")!, "mxc");
    const geometry = layoutGeometry(layout, LIB);
    const band = geometry.bands.find((candidate) => candidate.id === "mxc")!;
    // Parent: switch, the default isolator, the new coax; branch: one coax.
    expect(band.height).toBe(56 + 40 * 3);
    const swY = geometry.parts.find((p) => p.id === sw.id)!.y;
    const branchCoax = geometry.parts.find((p) => p.chainId === branchId)!;
    const parentYs = geometry.parts
      .filter((p) => p.chainId === "out1" && p.id !== sw.id && p.y > band.y && p.y < band.y + band.height)
      .map((p) => p.y);
    expect(branchCoax.y).toBe(swY + 40);
    expect(parentYs.sort((a, b) => b - a)).toEqual([swY - 40, swY - 80]);
    // Drops split the shared column at the switch glyph.
    const parent = geometry.chains.find((chain) => chain.id === "out1")!;
    const branch = geometry.chains.find((chain) => chain.id === branchId)!;
    expect(parent.dropBottomY).toBe(swY);
    expect(branch.dropTopY).toBe(swY);
    // Input: the parent's parts come first in the band, the branch's under them.
    let input = addPart(fridge(), "in1", LIB.get("switch_6way")!, "mxc");
    const inSw = input.chains[0].parts[input.chains[0].parts.length - 1];
    input = addPart(input, inSw.ports!["1"], LIB.get("attenuator_20db")!, "mxc");
    const inGeometry = layoutGeometry(input, LIB);
    const inSwY = inGeometry.parts.find((p) => p.id === inSw.id)!.y;
    expect(inGeometry.parts.find((p) => p.chainId === inSw.ports!["1"])!.y).toBe(inSwY + 40);
  });
});
