/* Pure helpers for the setup designer: layout edits that keep the
   document valid by construction (signal order, switch placement), the
   built in defaults mirrored from labcore/rfchain.py, and the geometry
   the schematic draws from. Everything here is synchronous and testable
   without a DOM. */

import { THROUGH_DEVICE, type Layout, type LayoutChain, type LayoutPart, type LayoutStage, type RfPart } from "../../api/client";

export const LAYOUT_VERSION = 1;
export const DEFAULT_FREQUENCY_GHZ = 6;
export const DEFAULT_BASE_TEMP_K = 0.02;

const FRIDGE_KINDS = new Set(["dilution_refrigerator", "adr", "lhe_dewar"]);

export function isEmptyLayout(layout: unknown): boolean {
  return (
    !layout ||
    typeof layout !== "object" ||
    !Array.isArray((layout as Layout).stages) ||
    (layout as Layout).stages.length === 0
  );
}

export function cloneLayout(layout: Layout): Layout {
  return JSON.parse(JSON.stringify(layout)) as Layout;
}

export function tempLabel(tempK: number): string {
  if (tempK >= 1) {
    return `${Number(tempK.toPrecision(6))} K`;
  }
  return `${Number((tempK * 1000).toPrecision(6))} mK`;
}

/* Mirror of labcore.rfchain.normalize_kind: free text kinds from before
   the Testbed template's select still resolve to a fridge default. */
export function normalizeKind(kind: string | null): string | null {
  if (!kind) {
    return null;
  }
  const text = kind.trim().toLowerCase();
  if (text.includes("dilution") || text === "dr" || text === "df") {
    return "dilution_refrigerator";
  }
  if (text.includes("adr") || text.includes("adiabatic")) {
    return "adr";
  }
  if (text.includes("dewar") || text.includes("lhe") || text.includes("helium")) {
    return "lhe_dewar";
  }
  if (text.includes("probe")) {
    return "probe_station";
  }
  if (text.includes("breadboard") || text.includes("optical") || text.includes("photonic")) {
    return "optical_breadboard";
  }
  return text.replaceAll(" ", "_");
}

/* Mirror of labcore.rfchain.default_layout. */
export function defaultLayout(rawKind: string | null, baseTempK: number | null): Layout {
  const kind = normalizeKind(rawKind);
  const base: Layout = {
    version: 1,
    frequency_ghz: DEFAULT_FREQUENCY_GHZ,
    stages: [],
    chains: [],
    optical: [],
    notes: "",
  };
  if (kind === "optical_breadboard") {
    return { ...base, stages: [{ id: "table", label: "Table 300 K", temp_k: 300 }] };
  }
  if (!kind || !FRIDGE_KINDS.has(kind)) {
    return {
      ...base,
      stages: [{ id: "rt", label: "300 K", temp_k: 300 }],
      chains: [
        { id: "in1", label: "Input 1", direction: "input", feedline: "A", parts: [] },
        { id: "out1", label: "Output 1", direction: "output", feedline: "A", parts: [] },
      ],
    };
  }
  let notes = "";
  let coldest = baseTempK;
  if (coldest === null || !(coldest > 0)) {
    coldest = DEFAULT_BASE_TEMP_K;
    notes = "base temperature assumed 20 mK; set it on the testbed";
  }
  // 300 K, the 50 K shield, the 4 K plate, one intermediate stage (still
  // for a dilution fridge, 800 mK for an ADR), and the base stage at the
  // testbed's temperature. Mirrors labcore.rfchain.default_layout.
  const stages: LayoutStage[] = [
    { id: "rt", label: "300 K", temp_k: 300 },
    { id: "50k", label: "50 K", temp_k: 50 },
    { id: "4k", label: "4 K", temp_k: 4 },
  ];
  if (kind === "dilution_refrigerator") {
    stages.push({ id: "still", label: "Still", temp_k: 0.8 });
  } else if (kind === "adr") {
    stages.push({ id: "adr1", label: "800 mK", temp_k: 0.8 });
  }
  if (coldest >= 0.8 && stages.length === 4) {
    stages.pop();
  }
  stages.push({ id: "mxc", label: tempLabel(coldest), temp_k: coldest });
  const middle = stages.length === 5 ? stages[3].id : "mxc";
  const inputParts: LayoutPart[] = [{ id: "in1-a", type: "attenuator_20db", stage: "4k" }];
  if (kind === "dilution_refrigerator" && middle !== "mxc") {
    inputParts.push({ id: "in1-b", type: "attenuator_20db", stage: "still" });
  }
  inputParts.push({ id: "in1-c", type: "attenuator_20db", stage: "mxc" });
  return {
    ...base,
    notes,
    stages,
    chains: [
      { id: "in1", label: "Input 1", direction: "input", feedline: "A", parts: inputParts },
      {
        id: "out1",
        label: "Output 1",
        direction: "output",
        feedline: "A",
        parts: [
          { id: "out1-a", type: "isolator", stage: "mxc" },
          { id: "out1-b", type: "coax_nbti", stage: middle },
          { id: "out1-c", type: "hemt", stage: "4k" },
        ],
      },
    ],
  };
}

export function setColdestStageTemp(layout: Layout, tempK: number | null): Layout {
  // A single stage layout (probe station, breadboard) has no cold stage.
  if (tempK === null || !(tempK > 0) || layout.stages.length < 2) {
    return layout;
  }
  const next = cloneLayout(layout);
  const coldest = next.stages[next.stages.length - 1];
  coldest.temp_k = tempK;
  coldest.label = tempLabel(tempK);
  return next;
}

// ---- lookups -------------------------------------------------------------

export function stageIndex(layout: Layout): Map<string, number> {
  return new Map(layout.stages.map((stage, index) => [stage.id, index]));
}

export function libraryById(parts: RfPart[]): Map<string, RfPart> {
  return new Map(parts.map((part) => [part.id, part]));
}

export function isSwitch(part: LayoutPart, library: Map<string, RfPart>): boolean {
  return (library.get(part.type)?.ports ?? 0) > 0;
}

/* The part nearest the device: last on an input chain, first on an output. */
export function deviceFacingIndex(chain: LayoutChain): number {
  return chain.direction === "input" ? chain.parts.length - 1 : 0;
}

export function terminalSwitch(
  chain: LayoutChain,
  library: Map<string, RfPart>,
): LayoutPart | null {
  if (chain.parts.length === 0) {
    return null;
  }
  const part = chain.parts[deviceFacingIndex(chain)];
  return isSwitch(part, library) ? part : null;
}

export interface ParentLink {
  chain: LayoutChain;
  part: LayoutPart;
  port: number;
}

export function parentMap(layout: Layout): Map<string, ParentLink> {
  const parents = new Map<string, ParentLink>();
  for (const chain of layout.chains) {
    for (const part of chain.parts) {
      for (const [key, target] of Object.entries(part.ports ?? {})) {
        if (!parents.has(target)) {
          parents.set(target, { chain, part, port: Number(key) });
        }
      }
    }
  }
  return parents;
}

export function findPart(
  layout: Layout,
  partId: string,
): { chain: LayoutChain; index: number; part: LayoutPart } | null {
  for (const chain of layout.chains) {
    const index = chain.parts.findIndex((part) => part.id === partId);
    if (index >= 0) {
      return { chain, index, part: chain.parts[index] };
    }
  }
  return null;
}

/* Leaves reached by following selected ports from every root, per
   direction, so the schematic can dim what the switches do not select. */
export function activeChainIds(layout: Layout, library: Map<string, RfPart>): Set<string> {
  const byId = new Map(layout.chains.map((chain) => [chain.id, chain]));
  const parents = parentMap(layout);
  const active = new Set<string>();
  for (const root of layout.chains) {
    if (parents.has(root.id)) {
      continue;
    }
    let current: LayoutChain | undefined = root;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      active.add(current.id);
      const sw = terminalSwitch(current, library);
      if (!sw || sw.selected_port === null || sw.selected_port === undefined) {
        break;
      }
      current = byId.get(sw.ports?.[String(sw.selected_port)] ?? "");
    }
  }
  return active;
}

// ---- ids -----------------------------------------------------------------

export function nextId(layout: Layout, prefix: string): string {
  const used = new Set<string>();
  for (const chain of layout.chains) {
    used.add(chain.id);
    for (const part of chain.parts) {
      used.add(part.id);
    }
  }
  for (const part of layout.optical) {
    used.add(part.id);
  }
  for (const stage of layout.stages) {
    used.add(stage.id);
  }
  let n = 1;
  while (used.has(`${prefix}${n}`)) {
    n += 1;
  }
  return `${prefix}${n}`;
}

// ---- edits (each returns a new layout) -----------------------------------

/* Where a part on `stageId` belongs in a chain so stage order holds: after
   the parts on warmer stages for inputs (colder for outputs), and never
   past a terminal switch. */
export function insertionIndex(
  layout: Layout,
  chain: LayoutChain,
  stageId: string,
  library: Map<string, RfPart>,
): number {
  const stages = stageIndex(layout);
  const target = stages.get(stageId) ?? 0;
  const sw = terminalSwitch(chain, library);
  let index = 0;
  for (const part of chain.parts) {
    const partStage = stages.get(part.stage) ?? 0;
    const before = chain.direction === "input" ? partStage <= target : partStage >= target;
    if (before) {
      index += 1;
    } else {
      break;
    }
  }
  if (sw) {
    if (chain.direction === "input") {
      index = Math.min(index, chain.parts.length - 1);
    } else {
      index = Math.max(index, 1);
    }
  }
  return index;
}

export function addPart(
  layout: Layout,
  chainId: string,
  type: RfPart,
  stageId: string,
  feedline?: string,
): Layout {
  const next = cloneLayout(layout);
  const library = new Map([[type.id, type]]);
  if (type.category === "optical") {
    if (type.destination === "device") {
      // A fiber ends on a device: it takes the feedline given, else the
      // dropped on chain's, else the first feedline; it sits on the
      // coldest stage.
      const chain = next.chains.find((candidate) => candidate.id === chainId);
      const target = feedline ?? chain?.feedline ?? feedlineLabels(next)[0];
      if (!target) {
        return layout;
      }
      next.optical.push({
        id: nextId(next, "o"),
        type: type.id,
        stage: next.stages[next.stages.length - 1].id,
        feedline: target,
      });
      return next;
    }
    next.optical.push({ id: nextId(next, "o"), type: type.id, stage: stageId });
    return next;
  }
  const chain = next.chains.find((candidate) => candidate.id === chainId);
  if (!chain) {
    return layout;
  }
  const part: LayoutPart = { id: nextId(next, "p"), type: type.id, stage: stageId };
  if (type.ports > 0) {
    if (terminalSwitch(chain, library) || chain.parts.some((p) => p.ports)) {
      return layout; // one switch per chain; branch it instead
    }
    // A switch faces the device, so the parts colder than it move onto a
    // branch on port 1 (with the chain's feedline) and the chain itself
    // ends at the switch.
    const stages = stageIndex(next);
    const target = stages.get(stageId) ?? 0;
    const colder = chain.parts.filter((p) => (stages.get(p.stage) ?? 0) > target);
    const warmer = chain.parts.filter((p) => (stages.get(p.stage) ?? 0) <= target);
    part.ports = {};
    part.selected_port = null;
    chain.parts = chain.direction === "input" ? [...warmer, part] : [part, ...warmer];
    const feedline = chain.feedline;
    delete chain.feedline;
    const branchId = nextId(next, `${chain.id}-`);
    part.ports["1"] = branchId;
    part.selected_port = 1;
    next.chains.push({
      id: branchId,
      label: "Port 1",
      direction: chain.direction,
      feedline: feedline ?? "A",
      parts: colder,
    });
    return next;
  }
  const index = insertionIndex(next, chain, stageId, library);
  chain.parts.splice(index, 0, part);
  return next;
}

/* Fibers name the feedline whose device they illuminate. When a label
   disappears (chain removed, switch folded, feedline renamed) they must
   not be left pointing at nothing: the server rejects the whole layout.
   `renamed` carries a label change so fibers follow it; otherwise an
   orphaned fiber moves to the first remaining feedline, or goes away
   when none is left. */
function reconcileFibers(next: Layout, renamed?: { from: string; to: string }): void {
  const labels = feedlineLabels(next);
  next.optical = next.optical.flatMap((part) => {
    if (part.feedline === undefined || labels.includes(part.feedline)) {
      return [part];
    }
    if (renamed && part.feedline === renamed.from && labels.includes(renamed.to)) {
      return [{ ...part, feedline: renamed.to }];
    }
    return labels.length > 0 ? [{ ...part, feedline: labels[0] }] : [];
  });
}

export function removePart(layout: Layout, partId: string): Layout {
  const next = cloneLayout(layout);
  const optical = next.optical.findIndex((part) => part.id === partId);
  if (optical >= 0) {
    next.optical.splice(optical, 1);
    return next;
  }
  const found = findPart(next, partId);
  if (!found) {
    return layout;
  }
  const ports = found.part.ports ?? {};
  found.chain.parts.splice(found.index, 1);
  if (Object.keys(ports).length === 0) {
    return next;
  }
  // Removing a switch reverses adding one: the selected branch (else the
  // lowest port) folds back onto the chain, in signal order, and hands
  // its feedline back; the other branches go.
  const keptKey =
    found.part.selected_port !== null && found.part.selected_port !== undefined && ports[String(found.part.selected_port)]
      ? String(found.part.selected_port)
      : Object.keys(ports).sort((a, b) => Number(a) - Number(b))[0];
  const kept = next.chains.find((chain) => chain.id === ports[keptKey]);
  if (kept) {
    found.chain.parts =
      found.chain.direction === "input"
        ? [...found.chain.parts, ...kept.parts]
        : [...kept.parts, ...found.chain.parts];
    if (kept.feedline) {
      found.chain.feedline = kept.feedline;
    }
    // Sub-branches of a switch inside the kept branch now hang off this
    // chain, so the kept chain itself goes without recursion.
    next.chains = next.chains.filter((chain) => chain.id !== kept.id);
  }
  const folded = Object.entries(ports)
    .filter(([key]) => key !== keptKey)
    .reduce((acc, [, branchId]) => removeChain(acc, branchId), next);
  reconcileFibers(folded);
  return folded;
}

/* Change a part's stage: re-insert at the order preserving position. */
export function setPartStage(
  layout: Layout,
  partId: string,
  stageId: string,
  library: Map<string, RfPart>,
): Layout {
  const next = cloneLayout(layout);
  const optical = next.optical.find((part) => part.id === partId);
  if (optical) {
    optical.stage = stageId;
    return next;
  }
  const found = findPart(next, partId);
  if (!found) {
    return layout;
  }
  const [part] = found.chain.parts.splice(found.index, 1);
  part.stage = stageId;
  if (isSwitch(part, library)) {
    if (found.chain.direction === "input") {
      found.chain.parts.push(part);
    } else {
      found.chain.parts.unshift(part);
    }
    return next;
  }
  const index = insertionIndex(next, found.chain, stageId, library);
  found.chain.parts.splice(index, 0, part);
  return next;
}

/* Swap with the neighbour in array order; crossing a stage boundary
   moves the part onto the neighbour's stage so order still holds. */
export function movePart(
  layout: Layout,
  partId: string,
  step: -1 | 1,
  library: Map<string, RfPart>,
): Layout {
  const next = cloneLayout(layout);
  const found = findPart(next, partId);
  if (!found) {
    return layout;
  }
  const target = found.index + step;
  if (target < 0 || target >= found.chain.parts.length) {
    return layout;
  }
  const neighbour = found.chain.parts[target];
  if (isSwitch(found.part, library) || isSwitch(neighbour, library)) {
    return layout; // the switch stays at the device facing end
  }
  found.chain.parts[found.index] = neighbour;
  found.chain.parts[target] = found.part;
  if (found.part.stage !== neighbour.stage) {
    found.part.stage = neighbour.stage;
  }
  return next;
}

export function bindPart(layout: Layout, partId: string, instrumentId: string | null): Layout {
  const next = cloneLayout(layout);
  const found = findPart(next, partId);
  if (!found) {
    return layout;
  }
  if (instrumentId) {
    found.part.instrument_id = instrumentId;
  } else {
    delete found.part.instrument_id;
  }
  return next;
}

export function addChain(layout: Layout, direction: "input" | "output"): Layout {
  const next = cloneLayout(layout);
  const prefix = direction === "input" ? "in" : "out";
  const count = next.chains.filter((chain) => chain.direction === direction).length + 1;
  // A new output pairs with the input that still lacks one (and vice
  // versa) before a fresh letter is minted.
  next.chains.push({
    id: nextId(next, prefix),
    label: `${direction === "input" ? "Input" : "Output"} ${count}`,
    direction,
    feedline: freeFeedline(next, direction),
    parts: [],
  });
  return next;
}

export function removeChain(layout: Layout, chainId: string): Layout {
  const next = cloneLayout(layout);
  const chain = next.chains.find((candidate) => candidate.id === chainId);
  if (!chain) {
    return layout;
  }
  const branches = chain.parts.flatMap((part) => Object.values(part.ports ?? {}));
  next.chains = next.chains.filter((candidate) => candidate.id !== chainId);
  // Unwire the port that pointed here.
  for (const other of next.chains) {
    for (const part of other.parts) {
      if (part.ports) {
        for (const [key, target] of Object.entries(part.ports)) {
          if (target === chainId) {
            delete part.ports[key];
            if (String(part.selected_port) === key) {
              part.selected_port = null;
            }
          }
        }
      }
    }
  }
  const pruned = branches.reduce((acc, branchId) => removeChain(acc, branchId), next);
  reconcileFibers(pruned);
  return pruned;
}

export function renameChain(
  layout: Layout,
  chainId: string,
  patch: { label?: string; feedline?: string },
): Layout {
  const next = cloneLayout(layout);
  const chain = next.chains.find((candidate) => candidate.id === chainId);
  if (!chain) {
    return layout;
  }
  if (patch.label !== undefined) {
    chain.label = patch.label;
  }
  if (patch.feedline !== undefined) {
    const previous = chain.feedline;
    chain.feedline = patch.feedline;
    if (previous !== undefined && previous !== patch.feedline) {
      reconcileFibers(next, { from: previous, to: patch.feedline });
    }
  }
  return next;
}

function feedlinesOf(layout: Layout, direction: "input" | "output"): Set<string> {
  return new Set(
    layout.chains
      .filter((chain) => chain.direction === direction && chain.feedline)
      .map((chain) => chain.feedline as string),
  );
}

/* A feedline label for a new leaf on `direction`: the preferred label if
   free on this side, else a label the other side already uses but this
   side does not (so an output switch's branches pair with the input
   switch's automatically), else the next unused letter. */
export function freeFeedline(
  layout: Layout,
  direction: "input" | "output",
  preferred?: string,
): string {
  const mine = feedlinesOf(layout, direction);
  if (preferred && !mine.has(preferred)) {
    return preferred;
  }
  const theirs = feedlinesOf(layout, direction === "input" ? "output" : "input");
  for (const label of [...theirs].sort()) {
    if (!mine.has(label)) {
      return label;
    }
  }
  const all = new Set([...mine, ...theirs]);
  let label = "A";
  while (all.has(label)) {
    label = String.fromCharCode(label.charCodeAt(0) + 1);
  }
  return label;
}

function branchBaseLabel(layout: Layout, sw: LayoutPart): string {
  for (const target of Object.values(sw.ports ?? {})) {
    const branch = layout.chains.find((chain) => chain.id === target);
    const base = branch?.feedline?.replace(/\d+$/, "");
    if (base) {
      return base;
    }
  }
  return "A";
}

export function addBranch(layout: Layout, switchId: string, port: number): Layout {
  const next = cloneLayout(layout);
  const found = findPart(next, switchId);
  if (!found || !found.part.ports || found.part.ports[String(port)]) {
    return layout;
  }
  const chainId = nextId(next, `${found.chain.id}-`);
  // Branch labels number from the switch's base label (A2, A3, …) so six
  // devices on one feedline read as one family.
  const base = branchBaseLabel(next, found.part);
  const label = freeFeedline(next, found.chain.direction, `${base}${port}`);
  found.part.ports[String(port)] = chainId;
  if (found.part.selected_port === null || found.part.selected_port === undefined) {
    found.part.selected_port = port;
  }
  next.chains.push({
    id: chainId,
    label: `Port ${port}`,
    direction: found.chain.direction,
    feedline: label,
    parts: [],
  });
  return next;
}

/* Wire a branch on every unused port of a switch. */
export function addAllBranches(
  layout: Layout,
  switchId: string,
  library: Map<string, RfPart>,
): Layout {
  const found = findPart(layout, switchId);
  if (!found) {
    return layout;
  }
  const count = library.get(found.part.type)?.ports ?? 0;
  let next = layout;
  for (let port = 1; port <= count; port += 1) {
    next = addBranch(next, switchId, port);
  }
  return next;
}

/* Copy one branch's parts onto every sibling branch of the same switch
   (replacing what they had), for the usual "six identical lines" case. */
export function replicateBranchParts(layout: Layout, chainId: string): Layout {
  const parents = parentMap(layout);
  const link = parents.get(chainId);
  if (!link) {
    return layout;
  }
  const next = cloneLayout(layout);
  const source = next.chains.find((chain) => chain.id === chainId);
  if (!source) {
    return layout;
  }
  for (const target of Object.values(link.part.ports ?? {})) {
    if (target === chainId) {
      continue;
    }
    const sibling = next.chains.find((chain) => chain.id === target);
    if (!sibling) {
      continue;
    }
    sibling.parts = source.parts.map((part) => {
      const copy: LayoutPart = { id: "", type: part.type, stage: part.stage };
      copy.id = nextId(next, "p");
      sibling.parts.push(copy); // reserve the id before the next copy
      return copy;
    });
  }
  return next;
}

/* Feedline labels currently carried by leaf chains, in drawing order. */
export function feedlineLabels(layout: Layout): string[] {
  const seen: string[] = [];
  for (const chain of layout.chains) {
    if (chain.feedline && !seen.includes(chain.feedline)) {
      seen.push(chain.feedline);
    }
  }
  return seen;
}

export function setFiberFeedline(layout: Layout, partId: string, feedline: string): Layout {
  const next = cloneLayout(layout);
  const part = next.optical.find((candidate) => candidate.id === partId);
  if (!part) {
    return layout;
  }
  part.feedline = feedline;
  return next;
}

export function bindFeedlineDevice(
  layout: Layout,
  label: string,
  deviceId: string | null,
): Layout {
  const next = cloneLayout(layout);
  const feedlines = { ...(next.feedlines ?? {}) };
  if (deviceId) {
    feedlines[label] = { ...(feedlines[label] ?? {}), device_id: deviceId };
  } else {
    delete feedlines[label];
  }
  next.feedlines = feedlines;
  return next;
}

/* A testbed default describes wiring, never which chips were in; a
   through line is wiring, so it stays. */
export function withoutDeviceBindings(layout: Layout): Layout {
  const next = cloneLayout(layout);
  const kept = Object.entries(next.feedlines ?? {}).filter(
    ([, binding]) => binding.device_id === THROUGH_DEVICE,
  );
  if (kept.length === 0) {
    delete next.feedlines;
  } else {
    next.feedlines = Object.fromEntries(kept);
  }
  return next;
}

export function selectPort(layout: Layout, switchId: string, port: number | null): Layout {
  const next = cloneLayout(layout);
  const found = findPart(next, switchId);
  if (!found) {
    return layout;
  }
  found.part.selected_port = port;
  return next;
}

export function addStage(layout: Layout, label: string, tempK: number): Layout {
  const next = cloneLayout(layout);
  const id = nextId(next, "s");
  const index = next.stages.findIndex((stage) => stage.temp_k < tempK);
  const stage: LayoutStage = { id, label, temp_k: tempK };
  if (index < 0) {
    next.stages.push(stage);
  } else {
    next.stages.splice(index, 0, stage);
  }
  return next;
}

export function stageOccupancy(layout: Layout, stageId: string): number {
  return (
    layout.chains.reduce(
      (count, chain) => count + chain.parts.filter((part) => part.stage === stageId).length,
      0,
    ) + layout.optical.filter((part) => part.stage === stageId).length
  );
}

export function removeStage(layout: Layout, stageId: string): Layout | string {
  const occupancy = stageOccupancy(layout, stageId);
  if (occupancy > 0) {
    return `Move or remove its ${occupancy} part${occupancy === 1 ? "" : "s"} first`;
  }
  if (layout.stages.length === 1) {
    return "A layout needs at least one stage";
  }
  const next = cloneLayout(layout);
  next.stages = next.stages.filter((stage) => stage.id !== stageId);
  return next;
}

export function updateStage(
  layout: Layout,
  stageId: string,
  patch: { label?: string; temp_k?: number },
): Layout | string {
  const next = cloneLayout(layout);
  const index = next.stages.findIndex((stage) => stage.id === stageId);
  if (index < 0) {
    return layout;
  }
  if (patch.temp_k !== undefined) {
    if (!(patch.temp_k > 0)) {
      return "Temperature must be above 0 K";
    }
    const warmer = next.stages[index - 1];
    const colder = next.stages[index + 1];
    if ((warmer && patch.temp_k >= warmer.temp_k) || (colder && patch.temp_k <= colder.temp_k)) {
      return "Stages must stay in decreasing temperature order";
    }
    next.stages[index].temp_k = patch.temp_k;
  }
  if (patch.label !== undefined) {
    next.stages[index].label = patch.label;
  }
  return next;
}

// ---- geometry ------------------------------------------------------------

export const GEOMETRY = {
  labelGutter: 96,
  columnGap: 120,
  // Branches of one switch share the parent's column group as narrow
  // sub columns, so six devices on a switch stay compact.
  subColumnGap: 56,
  fanDrop: 22,
  bandBase: 56,
  bandPerExtraPart: 40,
  topPad: 24,
  devicePad: 36,
  deviceBarPad: 24,
  deviceBarGap: 12,
  opticalGap: 60,
};

export interface PartPlacement {
  id: string;
  x: number;
  y: number;
  chainId: string | null; // null for optical parts
  // Narrow sub column: the schematic hides the text label.
  compact: boolean;
}

export interface ChainPlacement {
  id: string;
  x: number;
  topY: number;
  bottomY: number;
  leaf: boolean;
  active: boolean;
  compact: boolean;
  feedline?: string;
  direction: "input" | "output";
  // Vertical span that drops target this chain. A switch splits its band
  // at the glyph: above it belongs to the switch's chain, below it to the
  // branches, which share the column.
  dropTopY: number;
  dropBottomY: number;
}

export interface FanLine {
  fromPartId: string;
  toChainId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  port: number;
}

export interface StageBand {
  id: string;
  label: string;
  y: number;
  height: number;
}

export interface FiberLine {
  partId: string;
  feedline: string;
  x: number;
  topY: number;
  bottomY: number;
}

export interface SchematicGeometry {
  width: number;
  height: number;
  bands: StageBand[];
  chains: ChainPlacement[];
  parts: PartPlacement[];
  fans: FanLine[];
  fibers: FiberLine[];
  // One bar per feedline, spanning that feedline's leaf columns, with a
  // gap to its neighbours: each device reads as its own block.
  devices: DeviceBar[];
  deviceY: number | null;
  opticalX: number | null;
}

export interface DeviceBar {
  feedline: string;
  x1: number;
  x2: number;
  y: number;
}

/* Chains in drawing order: each root in array order, immediately followed
   by its branches in port order (depth first), so a fan never crosses an
   unrelated chain and the Chains panel reads like the schematic. Orphans
   (invalid drafts) come last so they still get a column. */
export function chainOrder(
  layout: Layout,
  library: Map<string, RfPart>,
): { chain: LayoutChain; depth: number }[] {
  const byId = new Map(layout.chains.map((chain) => [chain.id, chain]));
  const parents = parentMap(layout);
  const ordered: { chain: LayoutChain; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (chain: LayoutChain, depth: number): void => {
    if (seen.has(chain.id)) {
      return;
    }
    seen.add(chain.id);
    ordered.push({ chain, depth });
    const sw = terminalSwitch(chain, library);
    if (sw?.ports) {
      for (const key of Object.keys(sw.ports).sort((a, b) => Number(a) - Number(b))) {
        const branch = byId.get(sw.ports[key]);
        if (branch) {
          visit(branch, depth + 1);
        }
      }
    }
  };
  for (const chain of layout.chains) {
    if (!parents.has(chain.id)) {
      visit(chain, 0);
    }
  }
  for (const chain of layout.chains) {
    visit(chain, 0);
  }
  return ordered;
}

export function layoutGeometry(layout: Layout, library: Map<string, RfPart>): SchematicGeometry {
  const stages = stageIndex(layout);
  const cellCounts = new Map<string, number>();
  const cellKey = (chainId: string, stageId: string): string => `${chainId}::${stageId}`;
  for (const chain of layout.chains) {
    for (const part of chain.parts) {
      const key = cellKey(chain.id, part.stage);
      cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
    }
  }
  for (const part of layout.optical) {
    if (part.feedline) {
      continue; // fibers ride beside their feedline, not in the optical column
    }
    const key = cellKey("optical", part.stage);
    cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
  }
  const parents = parentMap(layout);
  const byId = new Map(layout.chains.map((chain) => [chain.id, chain]));
  // A branch's parts on the switch's own stage sit in the same band as the
  // switch (device side of it), so that band stacks parent plus the
  // tallest branch.
  const branchMax = (chain: LayoutChain, stageId: string): number => {
    const sw = terminalSwitch(chain, library);
    if (!sw?.ports || sw.stage !== stageId) {
      return 0;
    }
    return Math.max(0, ...Object.values(sw.ports).map((id) => cellCounts.get(cellKey(id, stageId)) ?? 0));
  };
  const parentCount = (chain: LayoutChain, stageId: string): number => {
    const parent = parents.get(chain.id);
    if (!parent || parent.part.stage !== stageId) {
      return 0;
    }
    return cellCounts.get(cellKey(parent.chain.id, stageId)) ?? 0;
  };
  const bands: StageBand[] = [];
  let y = GEOMETRY.topPad;
  for (const stage of layout.stages) {
    let maxCell = Math.max(1, cellCounts.get(cellKey("optical", stage.id)) ?? 0);
    for (const chain of layout.chains) {
      const own = cellCounts.get(cellKey(chain.id, stage.id)) ?? 0;
      maxCell = Math.max(maxCell, own + branchMax(chain, stage.id) + parentCount(chain, stage.id));
    }
    const height = GEOMETRY.bandBase + GEOMETRY.bandPerExtraPart * (maxCell - 1);
    bands.push({ id: stage.id, label: stage.label, y, height });
    y += height;
  }
  const bandsById = new Map(bands.map((band) => [band.id, band]));
  const bottomOfStages = y;
  const deviceY = bottomOfStages + GEOMETRY.devicePad / 2;

  const active = activeChainIds(layout, library);
  const chains: ChainPlacement[] = [];
  const parts: PartPlacement[] = [];
  const fans: FanLine[] = [];
  const cellUsed = new Map<string, number>();
  const ordered: LayoutChain[] = chainOrder(layout, library).map((entry) => entry.chain);
  // Column groups: a root owns a span wide enough for all its leaves at
  // sub column spacing (never narrower than one normal column); leaves
  // are spread evenly across the span, switches centred over theirs.
  const leafCount = (chain: LayoutChain): number => {
    const sw = terminalSwitch(chain, library);
    if (!sw?.ports) {
      return 1;
    }
    const branches = Object.values(sw.ports)
      .map((id) => byId.get(id))
      .filter((branch): branch is LayoutChain => Boolean(branch));
    return branches.length === 0 ? 1 : branches.reduce((sum, branch) => sum + leafCount(branch), 0);
  };
  const xById = new Map<string, number>();
  const compactById = new Map<string, boolean>();
  let cursor = GEOMETRY.labelGutter;
  const place = (chain: LayoutChain, start: number, width: number): void => {
    xById.set(chain.id, start + width / 2);
    compactById.set(chain.id, width < 100);
    const sw = terminalSwitch(chain, library);
    if (!sw?.ports) {
      return;
    }
    const branches = Object.keys(sw.ports)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => byId.get(sw.ports![key]))
      .filter((branch): branch is LayoutChain => Boolean(branch));
    const total = branches.reduce((sum, branch) => sum + leafCount(branch), 0) || 1;
    let inner = start;
    for (const branch of branches) {
      const share = (width * leafCount(branch)) / total;
      place(branch, inner, share);
      inner += share;
    }
  };
  for (const chain of ordered) {
    if (xById.has(chain.id)) {
      continue;
    }
    const width = Math.max(GEOMETRY.columnGap, leafCount(chain) * GEOMETRY.subColumnGap);
    place(chain, cursor, width);
    cursor += width;
  }
  const stagesEnd = cursor;
  ordered.forEach((chain) => {
    const x = xById.get(chain.id) ?? 0;
    const compact = compactById.get(chain.id) ?? false;
    const parent = parents.get(chain.id);
    const sw = terminalSwitch(chain, library);
    const leaf = sw === null;
    const parentBand = parent ? bandsById.get(parent.part.stage) : undefined;
    const topY = parentBand ? parentBand.y + parentBand.height / 2 : GEOMETRY.topPad;
    // A switch ended chain stops at its switch (the branches carry on).
    const switchBand = sw ? bandsById.get(sw.stage) : undefined;
    chains.push({
      id: chain.id,
      x,
      topY,
      bottomY: leaf ? deviceY : switchBand ? switchBand.y + GEOMETRY.bandBase / 2 : bottomOfStages,
      leaf,
      active: active.has(chain.id),
      compact,
      feedline: chain.feedline,
      direction: chain.direction,
      dropTopY: topY,
      dropBottomY: bottomOfStages,
    });
    for (const part of chain.parts) {
      const band = bandsById.get(part.stage);
      if (!band) {
        continue;
      }
      const key = cellKey(chain.id, part.stage);
      const slot = cellUsed.get(key) ?? 0;
      cellUsed.set(key, slot + 1);
      // Parts are in signal order: inputs stack top down within a band,
      // outputs bottom up (the device facing part sits lowest). In the
      // switch's band the device side parts come first in signal order:
      // on an input that is the parent's parts (branch parts stack under
      // them), on an output the branch parts (the switch sits above them).
      const base =
        chain.direction === "input"
          ? parentCount(chain, part.stage)
          : branchMax(chain, part.stage);
      const offset = GEOMETRY.bandBase / 2 + GEOMETRY.bandPerExtraPart * (base + slot);
      const y =
        chain.direction === "input" ? band.y + offset : band.y + band.height - offset;
      parts.push({ id: part.id, x, y, chainId: chain.id, compact });
    }
  });
  const partsById = new Map(parts.map((part) => [part.id, part]));
  const chainsById = new Map(chains.map((chain) => [chain.id, chain]));
  for (const [chainId, link] of parents) {
    const from = partsById.get(link.part.id);
    const to = chainsById.get(chainId);
    if (from && to) {
      fans.push({
        fromPartId: link.part.id,
        toChainId: chainId,
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: from.y + GEOMETRY.fanDrop,
        port: link.port,
      });
    }
  }
  // A branch's line starts where its fan line lands; a switch ended
  // chain's line ends exactly at the switch glyph.
  for (const fan of fans) {
    const target = chainsById.get(fan.toChainId);
    if (target) {
      target.topY = fan.y2;
      target.dropTopY = fan.y1;
    }
    const source = chainsById.get(partsById.get(fan.fromPartId)?.chainId ?? "");
    if (source) {
      source.bottomY = fan.y1;
      source.dropBottomY = fan.y1;
    }
  }
  const leaves = chains.filter((chain) => chain.leaf);
  // One bar per run of neighbouring leaf columns that share a feedline.
  // Runs rather than labels: a switch's branch (A2) can sit between the
  // input and output columns of A, and a bar per label would swallow it.
  const devices: DeviceBar[] = [];
  for (const leaf of [...leaves].sort((a, b) => a.x - b.x)) {
    const label = leaf.feedline ?? leaf.id;
    const last = devices[devices.length - 1];
    if (last && last.feedline === label) {
      last.x2 = leaf.x + GEOMETRY.deviceBarPad;
    } else {
      devices.push({
        feedline: label,
        x1: leaf.x - GEOMETRY.deviceBarPad,
        x2: leaf.x + GEOMETRY.deviceBarPad,
        y: deviceY,
      });
    }
  }
  // Neighbouring bars keep a visible gap even when their columns are close.
  for (let i = 1; i < devices.length; i += 1) {
    const gap = devices[i].x1 - devices[i - 1].x2;
    if (gap < GEOMETRY.deviceBarGap) {
      const middle = (devices[i - 1].x2 + devices[i].x1) / 2;
      devices[i - 1].x2 = middle - GEOMETRY.deviceBarGap / 2;
      devices[i].x1 = middle + GEOMETRY.deviceBarGap / 2;
    }
  }
  // Fibers: a dashed line beside the feedline's device column, glyph at
  // the fiber's stage.
  const fibers: FiberLine[] = [];
  const fiberSlots = new Map<string, number>();
  for (const part of layout.optical) {
    if (!part.feedline) {
      continue;
    }
    const leaf = chains.find((chain) => chain.leaf && chain.feedline === part.feedline);
    const band = bandsById.get(part.stage);
    if (!leaf || !band) {
      continue;
    }
    const slot = fiberSlots.get(part.feedline) ?? 0;
    fiberSlots.set(part.feedline, slot + 1);
    const x = leaf.x + 16 + 14 * slot;
    fibers.push({ partId: part.id, feedline: part.feedline, x, topY: GEOMETRY.topPad, bottomY: deviceY });
    parts.push({
      id: part.id,
      x,
      y: band.y + band.height / 2,
      chainId: null,
      compact: true,
    });
  }
  const columnOptical = layout.optical.filter((part) => !part.feedline);
  const opticalX = columnOptical.length > 0 ? stagesEnd + GEOMETRY.opticalGap : null;
  if (opticalX !== null) {
    for (const part of columnOptical) {
      const band = bandsById.get(part.stage);
      if (!band) {
        continue;
      }
      const key = cellKey("optical", part.stage);
      const slot = cellUsed.get(key) ?? 0;
      cellUsed.set(key, slot + 1);
      parts.push({
        id: part.id,
        x: opticalX,
        y: band.y + GEOMETRY.bandBase / 2 + GEOMETRY.bandPerExtraPart * slot,
        chainId: null,
        compact: false,
      });
    }
  }
  void stages;
  return {
    width: (opticalX ?? stagesEnd) + GEOMETRY.columnGap / 2,
    height: deviceY + GEOMETRY.devicePad,
    bands,
    chains,
    parts,
    fans,
    fibers,
    devices,
    deviceY: leaves.length > 0 ? deviceY : null,
    opticalX,
  };
}
