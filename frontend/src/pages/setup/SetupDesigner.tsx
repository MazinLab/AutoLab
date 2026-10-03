import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";

import {
  ApiError,
  evaluateLayout,
  getEntity,
  getRfParts,
  getSetupLayout,
  getWhoami,
  listAllEntities,
  listEntities,
  patchEntity,
  putSetupLayout,
  searchEntities,
  THROUGH_DEVICE,
  type Entity,
  type EvaluatedSide,
  type Layout,
  type LayoutEvaluation,
  type LayoutPart,
  type RfPart,
} from "../../api/client";
import { entityRoute } from "../entity/entityRoute";
import {
  addAllBranches,
  addBranch,
  addChain,
  addPart,
  addStage,
  bindFeedlineDevice,
  chainOrder,
  bindPart,
  cloneLayout,
  defaultLayout,
  feedlineLabels,
  findPart,
  isEmptyLayout,
  libraryById,
  movePart,
  parentMap,
  removeChain,
  removePart,
  removeStage,
  renameChain,
  replicateBranchParts,
  selectPort,
  setColdestStageTemp,
  setFiberFeedline,
  setPartStage,
  terminalSwitch,
  updateStage,
  withoutDeviceBindings,
} from "./rfLayout";
import { SetupSchematic } from "./SetupSchematic";
import "./setup.css";

interface SetupDesignerProps {
  setup: Entity;
  // The testbed this setup runs on (performed_on edge), if known.
  testbedId: string | null;
  // Called after a successful save so the page can refresh its ETag/version.
  onSaved?: () => void;
}

const EVALUATE_DEBOUNCE_MS = 300;
const STALE_MESSAGE =
  "This record changed since you loaded it. Reload the page, then re-apply your edit.";

function draftKey(setupId: string): string {
  return `autolab.setup-draft.${setupId}`;
}

function readDraft(setupId: string): Layout | null {
  try {
    const raw = window.sessionStorage.getItem(draftKey(setupId));
    return raw ? (JSON.parse(raw) as Layout) : null;
  } catch {
    return null;
  }
}

function writeDraft(setupId: string, layout: Layout | null): void {
  try {
    if (layout) {
      window.sessionStorage.setItem(draftKey(setupId), JSON.stringify(layout));
    } else {
      window.sessionStorage.removeItem(draftKey(setupId));
    }
  } catch {
    // Storage is a convenience; the draft still lives in component state.
  }
}

function sameLayout(a: Layout | null, b: Layout | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function formatK(value: number | undefined): string {
  if (value === undefined) {
    return "—";
  }
  if (value >= 1) {
    return `${value.toPrecision(4)} K`;
  }
  return `${(value * 1000).toPrecision(4)} mK`;
}

function formatDb(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(1)} dB`;
}

function SideNumbers({
  side,
  direction,
  library,
}: {
  side: EvaluatedSide | null;
  direction: "input" | "output";
  library: Map<string, RfPart>;
}): ReactElement {
  if (side === null) {
    return <p className="setup-results-status">No {direction} chain.</p>;
  }
  if (!side.active) {
    return (
      <p className="setup-results-status">
        {direction === "input" ? "Input" : "Output"} not selected by the switch
        ({side.chain_path.join(" › ")}).
      </p>
    );
  }
  return (
    <>
      <dl className="setup-numbers">
        {direction === "input" ? (
          <>
            <dt>Attenuation</dt>
            <dd>{formatDb(side.attenuation_db)}</dd>
            <dt>Noise at device</dt>
            <dd>{formatK(side.noise_temp_at_device_k)}</dd>
          </>
        ) : (
          <>
            <dt>Gain</dt>
            <dd>{formatDb(side.gain_db)}</dd>
            <dt>Added noise</dt>
            <dd>{formatK(side.added_noise_k)}</dd>
          </>
        )}
      </dl>
      {side.parts && side.parts.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Part</th>
              <th>Stage</th>
              <th>Gain</th>
              <th>{direction === "input" ? "Line noise" : "Contribution"}</th>
            </tr>
          </thead>
          <tbody>
            {side.parts.map((part) => (
              <tr key={part.id}>
                <td>
                  {library.get(part.type)?.label ?? part.type}
                  {part.source === "instrument"
                    ? " •"
                    : part.source === "missing_instrument"
                      ? " ?"
                      : ""}
                </td>
                <td>{part.stage}</td>
                <td>{formatDb(part.gain_db)}</td>
                <td>
                  {formatK(
                    direction === "input"
                      ? part.line_noise_after_k
                      : part.contribution_k,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

interface DeviceOption {
  id: string;
  name: string;
  accession: string;
}

function deviceLabel(device: DeviceOption): string {
  return device.name
    ? `${device.name} (${device.accession})`
    : device.accession;
}

/* Recent devices in a select, with a type ahead search for older ones. */
function DevicePicker({
  label,
  value,
  options,
  disabled,
  onPick,
}: {
  label: string;
  value: string | null;
  options: DeviceOption[];
  disabled: boolean;
  onPick: (device: DeviceOption | null) => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DeviceOption[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchEntities(trimmed, 25)
        .then((results) => {
          if (!cancelled) {
            setHits(
              results
                .filter((hit) => hit.entity_type === "device")
                .map((hit) => ({
                  id: hit.id,
                  name: hit.name,
                  accession: hit.accession,
                })),
            );
          }
        })
        .catch(() => {
          if (!cancelled) {
            setHits([]);
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);
  const shown = hits ?? options;
  const known = shown.some((device) => device.id === value);
  return (
    <div className="setup-device-row">
      <span className="setup-device-label">{label}</span>
      <select
        aria-label={`Device on feedline ${label}`}
        disabled={disabled}
        onChange={(event) => {
          const id = event.target.value;
          onPick(
            id === THROUGH_DEVICE
              ? { id: THROUGH_DEVICE, name: "Through", accession: "" }
              : (shown.find((device) => device.id === id) ?? null),
          );
          setQuery("");
          setIsSearching(false);
        }}
        value={value ?? ""}
      >
        <option value="">
          {hits
            ? hits.length === 0
              ? "No matches"
              : "Select a match…"
            : "No device"}
        </option>
        <option value={THROUGH_DEVICE}>Through line (no chip)</option>
        {value && value !== THROUGH_DEVICE && !known ? (
          <option value={value}>{value}</option>
        ) : null}
        {shown.map((device) => (
          <option key={device.id} value={device.id}>
            {deviceLabel(device)}
          </option>
        ))}
      </select>
      <button
        aria-label={`Search devices for feedline ${label}`}
        aria-pressed={isSearching}
        className="icon-button"
        disabled={disabled}
        onClick={() => {
          setIsSearching((open) => {
            if (open) {
              setQuery("");
            }
            return !open;
          });
        }}
        title="Search all devices"
        type="button"
      >
        ⌕
      </button>
      {value && value !== THROUGH_DEVICE ? (
        <Link
          aria-label={`Open device on feedline ${label}`}
          className="icon-button"
          title="Open device"
          to={entityRoute(value)}
        >
          ↗
        </Link>
      ) : (
        <span />
      )}
      {isSearching ? (
        <input
          aria-label={`Device search for feedline ${label}`}
          autoFocus
          className="setup-device-search"
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search devices…"
          type="search"
          value={query}
        />
      ) : null}
    </div>
  );
}

export function SetupDesigner({
  setup,
  testbedId,
  onSaved,
}: SetupDesignerProps): ReactElement {
  const [library, setLibrary] = useState<RfPart[] | null>(null);
  const [baseline, setBaseline] = useState<Layout | null>(null);
  const [draft, setDraft] = useState<Layout | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [savedEvaluation, setSavedEvaluation] =
    useState<LayoutEvaluation | null>(null);
  const [evaluation, setEvaluation] = useState<LayoutEvaluation | null>(null);
  const [evaluationRevision, setEvaluationRevision] = useState(0);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [draftRevision, setDraftRevision] = useState(0);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [dragTypeId, setDragTypeId] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(true);
  const [testbed, setTestbed] = useState<Entity | null>(null);
  const [amplifiers, setAmplifiers] = useState<Entity[] | null>(null);
  const [deviceOptions, setDeviceOptions] = useState<DeviceOption[]>([]);
  // Display names for bound devices, from picks and evaluation results.
  const [devicesById, setDevicesById] = useState<Record<string, DeviceOption>>(
    {},
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [addTo, setAddTo] = useState<{
    typeId: string;
    chainId: string;
    stageId: string;
    feedline?: string;
  } | null>(null);
  const [newStage, setNewStage] = useState({ label: "", temp: "" });
  const [confirmDefault, setConfirmDefault] = useState(false);
  const latestRevisionRef = useRef(0);

  const libraryMap = useMemo(() => libraryById(library ?? []), [library]);

  // Load the library, the saved layout, and identity once per setup.
  useEffect(() => {
    let cancelled = false;
    Promise.all([getRfParts(), getSetupLayout(setup.id)])
      .then(([parts, saved]) => {
        if (cancelled) {
          return;
        }
        setLibrary(parts.parts);
        const stored = isEmptyLayout(saved.data.layout)
          ? null
          : (saved.data.layout as Layout);
        setBaseline(stored);
        setEtag(saved.etag);
        setSavedEvaluation(saved.data.saved_evaluation);
        setEvaluation(saved.data.evaluation);
        const restored = readDraft(setup.id);
        if (restored && !sameLayout(restored, stored)) {
          setDraft(restored);
          setRestoredDraft(true);
          setDraftRevision(1);
        } else {
          setDraft(stored ? cloneLayout(stored) : null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "The setup layout could not be loaded.",
          );
        }
      });
    listEntities("device", { limit: 100, order: "desc" })
      .then((rows) => {
        if (!cancelled) {
          setDeviceOptions(
            rows.map((row) => ({
              id: row.id,
              name: row.name,
              accession: row.accession,
            })),
          );
        }
      })
      .catch(() => {
        // The search box still works without the recent list.
      });
    getWhoami()
      .then((whoami) => {
        if (!cancelled && whoami.can_write === false) {
          setCanWrite(false);
        }
      })
      .catch(() => {
        // Unknown identity: assume writable; the server still gates writes.
      });
    return () => {
      cancelled = true;
    };
  }, [setup.id]);

  useEffect(() => {
    if (!testbedId) {
      setTestbed(null);
      return;
    }
    let cancelled = false;
    getEntity("instrument", testbedId)
      .then((response) => {
        if (!cancelled) {
          setTestbed(response.data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTestbed(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [testbedId]);

  // Live evaluation, debounced, tagged with the draft revision it was
  // sent for so a late response never replaces a newer result.
  useEffect(() => {
    if (draftRevision === 0 || !draft) {
      return;
    }
    const revision = draftRevision;
    latestRevisionRef.current = revision;
    const timer = window.setTimeout(() => {
      evaluateLayout(draft)
        .then((result) => {
          if (latestRevisionRef.current !== revision) {
            return;
          }
          setEvaluation(result);
          setEvaluationRevision(revision);
          setValidationErrors([]);
          setDevicesById((current) => {
            const next = { ...current };
            for (const entry of Object.values(result.feedlines)) {
              if (
                entry.device &&
                !entry.device.missing &&
                entry.device.accession
              ) {
                next[entry.device.id] = {
                  id: entry.device.id,
                  name: entry.device.name ?? "",
                  accession: entry.device.accession,
                };
              }
            }
            return next;
          });
        })
        .catch((error: unknown) => {
          if (latestRevisionRef.current !== revision) {
            return;
          }
          const detail =
            error instanceof ApiError && typeof error.detail === "string"
              ? error.detail
              : null;
          setValidationErrors(
            detail
              ? detail.replace(/^invalid layout: /, "").split("; ")
              : [error instanceof Error ? error.message : "Evaluation failed."],
          );
        });
    }, EVALUATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, draftRevision]);

  const isDirty = draft !== null && !sameLayout(draft, baseline);

  useEffect(() => {
    if (!isDirty) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty]);

  const edit = useCallback(
    (next: Layout | string) => {
      if (typeof next === "string") {
        setNotice(next);
        return;
      }
      setNotice(null);
      setDraft(next);
      setDraftRevision((revision) => revision + 1);
      writeDraft(setup.id, next);
    },
    [setup.id],
  );

  function loadAmplifiers(): void {
    if (amplifiers !== null) {
      return;
    }
    listAllEntities("instrument", { filters: { category: "experimental" } })
      .then((rows) => {
        const match = rows.filter((row) =>
          /hemt|paramp/i.test(String(row.kind ?? "")),
        );
        setAmplifiers(match.length > 0 ? match : rows);
      })
      .catch(() => setAmplifiers([]));
  }

  function startFromDefault(): void {
    const kind = testbed ? String(testbed.kind ?? "") : null;
    const setupBase =
      typeof setup.base_temp_mk === "number" ? setup.base_temp_mk / 1000 : null;
    const testbedBase =
      testbed && typeof testbed.extra?.base_temp_mk === "number"
        ? (testbed.extra.base_temp_mk as number) / 1000
        : null;
    const base = setupBase ?? testbedBase;
    const stored =
      testbed && !isEmptyLayout(testbed.default_layout)
        ? (testbed.default_layout as Layout)
        : null;
    const next = stored
      ? setColdestStageTemp(cloneLayout(stored), base)
      : defaultLayout(kind, base);
    edit(next);
  }

  async function save(): Promise<void> {
    if (!draft) {
      return;
    }
    setSaveError(null);
    setIsSaving(true);
    try {
      const result = await putSetupLayout(setup.id, draft, etag);
      setBaseline(cloneLayout(draft));
      setEtag(result.etag);
      setSavedEvaluation(result.data.saved_evaluation);
      setEvaluation(result.data.evaluation);
      setValidationErrors([]);
      writeDraft(setup.id, null);
      setRestoredDraft(false);
      onSaved?.();
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 412) {
        setSaveError(STALE_MESSAGE);
      } else {
        setSaveError(
          error instanceof Error
            ? error.message
            : "The layout could not be saved.",
        );
      }
    } finally {
      setIsSaving(false);
    }
  }

  function discard(): void {
    setDraft(baseline ? cloneLayout(baseline) : null);
    setDraftRevision((revision) => revision + 1);
    setValidationErrors([]);
    writeDraft(setup.id, null);
    setRestoredDraft(false);
    setSelectedPartId(null);
  }

  async function saveAsDefault(): Promise<void> {
    if (!draft || !testbedId) {
      return;
    }
    setConfirmDefault(false);
    setSaveError(null);
    try {
      const current = await getEntity("instrument", testbedId);
      await patchEntity(
        "instrument",
        testbedId,
        { default_layout: withoutDeviceBindings(draft) },
        current.etag ?? undefined,
      );
      setNotice(
        `Saved as the default for ${current.data.name || current.data.accession}.`,
      );
    } catch (error: unknown) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "The testbed default could not be saved.",
      );
    }
  }

  function handleDrop(
    typeId: string,
    chainId: string | null,
    stageId: string,
  ): void {
    if (!draft) {
      return;
    }
    const spec = libraryMap.get(typeId);
    if (!spec) {
      return;
    }
    if (spec.category === "optical") {
      edit(addPart(draft, chainId ?? "", spec, stageId, addTo?.feedline));
    } else if (chainId) {
      edit(addPart(draft, chainId, spec, stageId));
    }
    setDragTypeId(null);
  }

  if (loadError) {
    return (
      <p className="entity-activity-status entity-activity-status--error">
        {loadError}
      </p>
    );
  }
  if (!library || draft === undefined) {
    return <p className="entity-activity-status">Loading setup designer…</p>;
  }
  if (!draft) {
    return (
      <div className="setup-designer">
        <p className="empty-state">No layout yet.</p>
        {canWrite ? (
          <div className="setup-toolbar">
            <button
              className="secondary-button"
              onClick={startFromDefault}
              type="button"
            >
              Start from testbed default
            </button>
            {!testbedId ? (
              <span className="setup-draft-notice">
                This setup names no testbed; a generic layout will be used.
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  const selected = selectedPartId ? findPart(draft, selectedPartId) : null;
  const selectedOptical = selectedPartId
    ? (draft.optical.find((part) => part.id === selectedPartId) ?? null)
    : null;
  const selectedPart: LayoutPart | null = selected?.part ?? selectedOptical;
  const selectedSpec = selectedPart
    ? (libraryMap.get(selectedPart.type) ?? null)
    : null;
  const isStale =
    validationErrors.length > 0 ||
    (draftRevision > 0 && evaluationRevision !== draftRevision);
  const savedDiffers =
    savedEvaluation !== null &&
    evaluation !== null &&
    JSON.stringify(savedEvaluation.feedlines) !==
      JSON.stringify(evaluation.feedlines);
  const grouped = new Map<string, RfPart[]>();
  for (const part of library) {
    grouped.set(part.category, [...(grouped.get(part.category) ?? []), part]);
  }
  const deviceNames: Record<string, string> = {};
  for (const [label, binding] of Object.entries(draft.feedlines ?? {})) {
    if (binding.device_id === THROUGH_DEVICE) {
      deviceNames[label] = "Through";
    } else if (binding.device_id) {
      const known =
        devicesById[binding.device_id] ??
        deviceOptions.find((d) => d.id === binding.device_id);
      deviceNames[label] = known
        ? known.name || known.accession
        : binding.device_id;
    }
  }

  return (
    <div className="setup-designer">
      {restoredDraft ? (
        <p className="setup-draft-notice" role="status">
          Unsaved draft restored. Save to keep it, or Discard to go back to the
          saved layout.
        </p>
      ) : null}
      {canWrite ? (
        <div className="setup-toolbar">
          <button
            className="secondary-button"
            onClick={() => edit(addChain(draft, "input"))}
            type="button"
          >
            + Input
          </button>
          <button
            className="secondary-button"
            onClick={() => edit(addChain(draft, "output"))}
            type="button"
          >
            + Output
          </button>
          <span className="spacer" />
          <button
            className="primary-button"
            disabled={!isDirty || isSaving}
            onClick={() => void save()}
            type="button"
          >
            {isSaving ? "Saving…" : "Save layout"}
          </button>
          <button
            className="secondary-button"
            disabled={!isDirty || isSaving}
            onClick={discard}
            type="button"
          >
            Discard
          </button>
          {testbedId ? (
            confirmDefault ? (
              <button
                className="secondary-button"
                onClick={() => void saveAsDefault()}
                type="button"
              >
                Confirm: replace testbed default
              </button>
            ) : (
              <button
                className="secondary-button"
                onClick={() => setConfirmDefault(true)}
                type="button"
              >
                Save as testbed default
              </button>
            )
          ) : null}
        </div>
      ) : null}
      {saveError ? (
        <p aria-live="polite" className="form-message form-message--error">
          {saveError}
        </p>
      ) : null}
      {notice ? (
        <p aria-live="polite" className="form-message form-message--success">
          {notice}
        </p>
      ) : null}

      <div className="setup-body">
        <div className="setup-canvas">
          <SetupSchematic
            deviceNames={deviceNames}
            dragTypeId={dragTypeId}
            layout={draft}
            library={libraryMap}
            onDropPart={canWrite ? handleDrop : undefined}
            onSelectPart={setSelectedPartId}
            selectedPartId={selectedPartId}
          />
        </div>

        {canWrite ? (
          <div className="setup-side">
            <section aria-label="Parts palette" className="setup-panel">
              <h3>Parts</h3>
              {[...grouped.entries()].map(([category, parts]) => (
                <details className="setup-palette-group" key={category} open>
                  <summary>{category}</summary>
                  {parts.map((part) => (
                    <div
                      className="setup-palette-item"
                      draggable
                      key={part.id}
                      onDragEnd={() => setDragTypeId(null)}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/rf-part", part.id);
                        setDragTypeId(part.id);
                      }}
                    >
                      <span>
                        {part.label}
                        {part.gain_db !== null ? (
                          <small> {part.gain_db} dB</small>
                        ) : null}
                      </span>
                      <button
                        aria-label={`Add ${part.label} to…`}
                        className="text-button"
                        onClick={() =>
                          setAddTo({
                            typeId: part.id,
                            chainId:
                              part.category === "optical"
                                ? "optical"
                                : (draft.chains.find((chain) =>
                                    part.directions.includes(chain.direction),
                                  )?.id ?? ""),
                            stageId:
                              draft.stages.find(
                                (stage) => stage.id === part.default_stage,
                              )?.id ?? draft.stages[draft.stages.length - 1].id,
                          })
                        }
                        type="button"
                      >
                        + Add to…
                      </button>
                    </div>
                  ))}
                </details>
              ))}
              {addTo ? (
                <form
                  aria-label="Add part"
                  className="setup-inspector-actions"
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleDrop(
                      addTo.typeId,
                      addTo.chainId === "optical" ? null : addTo.chainId,
                      addTo.stageId,
                    );
                    setAddTo(null);
                  }}
                >
                  {libraryMap.get(addTo.typeId)?.destination === "device" ? (
                    <select
                      aria-label="Feedline"
                      onChange={(event) =>
                        setAddTo({ ...addTo, feedline: event.target.value })
                      }
                      value={addTo.feedline ?? feedlineLabels(draft)[0] ?? ""}
                    >
                      {feedlineLabels(draft).map((label) => (
                        <option key={label} value={label}>
                          {deviceNames[label]
                            ? `${label} · ${deviceNames[label]}`
                            : label}
                        </option>
                      ))}
                    </select>
                  ) : addTo.chainId !== "optical" ? (
                    <select
                      aria-label="Chain"
                      onChange={(event) =>
                        setAddTo({ ...addTo, chainId: event.target.value })
                      }
                      value={addTo.chainId}
                    >
                      {draft.chains
                        .filter((chain) =>
                          libraryMap
                            .get(addTo.typeId)
                            ?.directions.includes(chain.direction),
                        )
                        .map((chain) => (
                          <option key={chain.id} value={chain.id}>
                            {chain.label}
                          </option>
                        ))}
                    </select>
                  ) : null}
                  {libraryMap.get(addTo.typeId)?.destination ===
                  "device" ? null : (
                    <select
                      aria-label="Stage"
                      onChange={(event) =>
                        setAddTo({ ...addTo, stageId: event.target.value })
                      }
                      value={addTo.stageId}
                    >
                      {draft.stages.map((stage) => (
                        <option key={stage.id} value={stage.id}>
                          {stage.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button className="secondary-button" type="submit">
                    Add
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setAddTo(null)}
                    type="button"
                  >
                    Cancel
                  </button>
                </form>
              ) : null}
            </section>

            <section
              aria-label="Inspector"
              className="setup-panel setup-inspector"
            >
              <h3>Selected part</h3>
              {!selectedPart || !selectedSpec ? (
                <p className="setup-results-status">
                  Click a part in the schematic.
                </p>
              ) : (
                <>
                  <dl>
                    <dt>Type</dt>
                    <dd>{selectedSpec.label}</dd>
                    {selectedSpec.gain_db !== null ? (
                      <>
                        <dt>Library</dt>
                        <dd>
                          {selectedSpec.gain_db} dB
                          {selectedSpec.noise_temp_k !== null
                            ? `, ${selectedSpec.noise_temp_k} K`
                            : ""}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                  <div className="setup-inspector-actions">
                    {selectedSpec.destination === "device" ? (
                      <label>
                        Device{" "}
                        <select
                          aria-label="Fiber feedline"
                          onChange={(event) =>
                            edit(
                              setFiberFeedline(
                                draft,
                                selectedPart.id,
                                event.target.value,
                              ),
                            )
                          }
                          value={selectedPart.feedline ?? ""}
                        >
                          {feedlineLabels(draft).map((label) => (
                            <option key={label} value={label}>
                              {deviceNames[label]
                                ? `${label} · ${deviceNames[label]}`
                                : label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <label>
                        Stage{" "}
                        <select
                          aria-label="Part stage"
                          onChange={(event) =>
                            edit(
                              setPartStage(
                                draft,
                                selectedPart.id,
                                event.target.value,
                                libraryMap,
                              ),
                            )
                          }
                          value={selectedPart.stage}
                        >
                          {draft.stages.map((stage) => (
                            <option key={stage.id} value={stage.id}>
                              {stage.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {selected ? (
                      <>
                        <button
                          className="text-button"
                          onClick={() =>
                            edit(
                              movePart(draft, selectedPart.id, -1, libraryMap),
                            )
                          }
                          type="button"
                        >
                          Move up
                        </button>
                        <button
                          className="text-button"
                          onClick={() =>
                            edit(
                              movePart(draft, selectedPart.id, 1, libraryMap),
                            )
                          }
                          type="button"
                        >
                          Move down
                        </button>
                      </>
                    ) : null}
                    <button
                      className="text-button text-button--danger"
                      onClick={() => {
                        edit(removePart(draft, selectedPart.id));
                        setSelectedPartId(null);
                      }}
                      type="button"
                    >
                      Remove
                    </button>
                    {selected && parentMap(draft).has(selected.chain.id) ? (
                      <button
                        className="text-button"
                        onClick={() =>
                          edit(replicateBranchParts(draft, selected.chain.id))
                        }
                        title="Replace every sibling branch's parts with this branch's"
                        type="button"
                      >
                        Copy parts to sibling branches
                      </button>
                    ) : null}
                  </div>
                  {selectedSpec.ports > 0 ? (
                    <div className="setup-inspector-actions">
                      <span>Ports:</span>
                      {Array.from(
                        { length: selectedSpec.ports },
                        (_, index) => index + 1,
                      ).map((port) => {
                        const target = selectedPart.ports?.[String(port)];
                        // The button lives beside the label, not inside it, so a
                        // click on it is never treated as a click on the radio.
                        return (
                          <span className="setup-port" key={port}>
                            <label>
                              <input
                                aria-label={`Select port ${port}`}
                                checked={selectedPart.selected_port === port}
                                disabled={!target}
                                name={`port-${selectedPart.id}`}
                                onChange={() =>
                                  edit(selectPort(draft, selectedPart.id, port))
                                }
                                type="radio"
                              />
                              {port}
                            </label>
                            {target ? (
                              <span className="setup-port-target">
                                →{" "}
                                {draft.chains.find(
                                  (chain) => chain.id === target,
                                )?.label ?? target}
                              </span>
                            ) : (
                              <button
                                className="text-button"
                                onClick={() =>
                                  edit(addBranch(draft, selectedPart.id, port))
                                }
                                type="button"
                              >
                                add branch
                              </button>
                            )}
                          </span>
                        );
                      })}
                      <button
                        className="text-button"
                        onClick={() =>
                          edit(
                            addAllBranches(draft, selectedPart.id, libraryMap),
                          )
                        }
                        type="button"
                      >
                        Add branches on all ports
                      </button>
                      <label>
                        <input
                          aria-label="No port selected"
                          checked={
                            selectedPart.selected_port === null ||
                            selectedPart.selected_port === undefined
                          }
                          name={`port-${selectedPart.id}`}
                          onChange={() =>
                            edit(selectPort(draft, selectedPart.id, null))
                          }
                          type="radio"
                        />
                        none
                      </label>
                    </div>
                  ) : null}
                  {selectedSpec.bindable ? (
                    <div className="setup-inspector-actions">
                      <label>
                        Instrument{" "}
                        <select
                          aria-label="Bound instrument"
                          onChange={(event) =>
                            edit(
                              bindPart(
                                draft,
                                selectedPart.id,
                                event.target.value || null,
                              ),
                            )
                          }
                          onFocus={loadAmplifiers}
                          value={selectedPart.instrument_id ?? ""}
                        >
                          <option value="">Unbound (library values)</option>
                          {selectedPart.instrument_id &&
                          !amplifiers?.some(
                            (row) => row.id === selectedPart.instrument_id,
                          ) ? (
                            <option value={selectedPart.instrument_id}>
                              {selectedPart.instrument_id}
                            </option>
                          ) : null}
                          {(amplifiers ?? []).map((row) => (
                            <option key={row.id} value={row.id}>
                              {row.name || row.accession}
                              {typeof row.extra?.gain_db === "number"
                                ? ` (${row.extra.gain_db} dB`
                                : ""}
                              {typeof row.extra?.noise_temp_k === "number"
                                ? `, ${row.extra.noise_temp_k} K)`
                                : typeof row.extra?.gain_db === "number"
                                  ? ")"
                                  : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      {selectedPart.instrument_id ? (
                        <Link to={entityRoute(selectedPart.instrument_id)}>
                          open
                        </Link>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </section>

            <section aria-label="Devices" className="setup-panel">
              <h3>Devices</h3>
              {feedlineLabels(draft).length === 0 ? (
                <p className="setup-results-status">No feedlines yet.</p>
              ) : null}
              {feedlineLabels(draft).map((label) => (
                <DevicePicker
                  disabled={isSaving}
                  key={label}
                  label={label}
                  onPick={(device) => {
                    if (device && device.id !== THROUGH_DEVICE) {
                      setDevicesById((current) => ({
                        ...current,
                        [device.id]: device,
                      }));
                    }
                    edit(bindFeedlineDevice(draft, label, device?.id ?? null));
                  }}
                  options={deviceOptions}
                  value={draft.feedlines?.[label]?.device_id ?? null}
                />
              ))}
            </section>

            <section aria-label="Chains" className="setup-panel">
              <h3>Chains</h3>
              {chainOrder(draft, libraryMap).map(({ chain, depth }) => (
                <div
                  className="setup-chain-row"
                  key={chain.id}
                  style={
                    depth > 0 ? { paddingLeft: `${depth * 14}px` } : undefined
                  }
                >
                  <input
                    aria-label={`Chain ${chain.id} label`}
                    onChange={(event) =>
                      edit(
                        renameChain(draft, chain.id, {
                          label: event.target.value,
                        }),
                      )
                    }
                    type="text"
                    value={chain.label}
                  />
                  <span className="setup-chain-direction">
                    {chain.direction}
                  </span>
                  {terminalSwitch(chain, libraryMap) === null ? (
                    <input
                      aria-label={`Chain ${chain.id} feedline`}
                      onChange={(event) =>
                        edit(
                          renameChain(draft, chain.id, {
                            feedline: event.target.value,
                          }),
                        )
                      }
                      placeholder="feedline"
                      type="text"
                      value={chain.feedline ?? ""}
                    />
                  ) : (
                    <span className="setup-chain-direction">switch</span>
                  )}
                  <button
                    aria-label={`Remove chain ${chain.label}`}
                    className="icon-button icon-button--danger"
                    onClick={() => edit(removeChain(draft, chain.id))}
                    title={`Remove ${chain.label}`}
                    type="button"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </section>
            <details
              aria-label="Stages"
              className="setup-panel setup-panel--collapsible"
            >
              <summary>
                <h3>Stages</h3>
                <small>rarely needed: temperatures and extra stages</small>
              </summary>
              {draft.stages.map((stage) => (
                <div className="setup-stage-row" key={stage.id}>
                  <input
                    aria-label={`Stage ${stage.id} label`}
                    onChange={(event) =>
                      edit(
                        updateStage(draft, stage.id, {
                          label: event.target.value,
                        }),
                      )
                    }
                    type="text"
                    value={stage.label}
                  />
                  <input
                    aria-label={`Stage ${stage.id} temperature (K)`}
                    min={0}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value)) {
                        edit(updateStage(draft, stage.id, { temp_k: value }));
                      }
                    }}
                    step="any"
                    type="number"
                    value={stage.temp_k}
                  />
                  <span>K</span>
                  <button
                    aria-label={`Remove stage ${stage.label}`}
                    className="icon-button icon-button--danger"
                    onClick={() => edit(removeStage(draft, stage.id))}
                    title={`Remove ${stage.label}`}
                    type="button"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <form
                aria-label="Add stage"
                className="setup-stage-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  const temp = Number(newStage.temp);
                  if (!newStage.label.trim() || !(temp > 0)) {
                    setNotice(
                      "A new stage needs a label and a temperature above 0 K.",
                    );
                    return;
                  }
                  edit(addStage(draft, newStage.label.trim(), temp));
                  setNewStage({ label: "", temp: "" });
                }}
              >
                <input
                  aria-label="New stage label"
                  onChange={(event) =>
                    setNewStage({ ...newStage, label: event.target.value })
                  }
                  placeholder="Label"
                  type="text"
                  value={newStage.label}
                />
                <input
                  aria-label="New stage temperature (K)"
                  onChange={(event) =>
                    setNewStage({ ...newStage, temp: event.target.value })
                  }
                  placeholder="K"
                  step="any"
                  type="number"
                  value={newStage.temp}
                />
                <button className="secondary-button" type="submit">
                  Add stage
                </button>
              </form>
            </details>
          </div>
        ) : null}
      </div>

      <details
        aria-label="Results"
        className="setup-panel setup-panel--collapsible"
      >
        <summary>
          <h3>Feedlines at {draft.frequency_ghz} GHz</h3>
          <small>
            {evaluation
              ? Object.entries(evaluation.feedlines)
                  .filter(([, sides]) => sides.output?.active)
                  .map(
                    ([label, sides]) =>
                      `${label}: ${formatDb(sides.output?.gain_db)} / ${formatK(sides.output?.added_noise_k)}`,
                  )
                  .join(" · ") || "no active output"
              : "no evaluation yet"}
            {isStale ? " (stale)" : ""}
          </small>
        </summary>
        <p className="setup-results-status">
          Classical estimate
          {evaluation ? `, library v${evaluation.library_version}` : ""}.
        </p>
        {isStale ? (
          <p
            className="setup-results-status setup-results-status--stale"
            role="status"
          >
            {validationErrors.length > 0
              ? "Stale: the draft is not valid."
              : "Stale: evaluating…"}
          </p>
        ) : null}
        {validationErrors.length > 0 ? (
          <ul className="setup-warnings">
            {validationErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
        {evaluation ? (
          <div className="setup-results">
            {Object.entries(evaluation.feedlines).map(([label, sides]) => (
              <article className="setup-feedline" key={label}>
                <h4>
                  Feedline {label}
                  {sides.device?.through ? (
                    " · Through line"
                  ) : sides.device && !sides.device.missing ? (
                    <>
                      {" · "}
                      <Link to={entityRoute(sides.device.id)}>
                        {sides.device.name || sides.device.accession}
                      </Link>
                    </>
                  ) : null}
                </h4>
                <SideNumbers
                  direction="input"
                  library={libraryMap}
                  side={sides.input}
                />
                <SideNumbers
                  direction="output"
                  library={libraryMap}
                  side={sides.output}
                />
              </article>
            ))}
          </div>
        ) : (
          <p className="setup-results-status">No evaluation yet.</p>
        )}
        {evaluation && evaluation.warnings.length > 0 ? (
          <ul className="setup-warnings">
            {evaluation.warnings.map((warning, index) => (
              <li key={`${warning.message}-${index}`}>{warning.message}</li>
            ))}
          </ul>
        ) : null}
        {savedDiffers && savedEvaluation ? (
          <p className="setup-saved-diff">
            Saved result differs (saved{" "}
            {savedEvaluation.evaluated_at
              ? new Date(savedEvaluation.evaluated_at).toLocaleDateString()
              : ""}{" "}
            with library v{savedEvaluation.library_version}):{" "}
            {Object.entries(savedEvaluation.feedlines)
              .map(
                ([label, sides]) =>
                  `${label}: out ${formatDb(sides.output?.gain_db)} / ${formatK(sides.output?.added_noise_k)}`,
              )
              .join("; ")}
          </p>
        ) : null}
      </details>
    </div>
  );
}
