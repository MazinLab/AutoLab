import { useCallback, useReducer, useState } from "react";
import { Link } from "react-router-dom";

import {
  createEdge,
  createEntity,
  getLineageGraph,
  listEntities,
  resolveAccession,
  type Entity,
} from "../../api/client";
import { AccessionScanner } from "../scan";
import "./mount.css";

const PAGE_SIZE = 100;

interface CooldownEntity extends Entity {
  ended_at?: string | null;
  started_at?: string | null;
}

type MountState =
  | {
      step: "instrument";
      busy: boolean;
      error: string | null;
    }
  | {
      step: "cooldown";
      busy: boolean;
      error: string | null;
      instrument: Entity;
      cooldowns: CooldownEntity[];
      pendingCooldown: CooldownEntity | null;
    }
  | {
      step: "device";
      busy: boolean;
      error: string | null;
      instrument: Entity;
      cooldown: CooldownEntity;
    }
  | {
      step: "success";
      busy: false;
      error: null;
      instrument: Entity;
      cooldown: CooldownEntity;
      device: Entity;
    };

type MountAction =
  | { type: "start" }
  | { type: "fail"; message: string }
  | {
      type: "instrument-ready";
      instrument: Entity;
      cooldowns: CooldownEntity[];
    }
  | { type: "cooldown-selected"; cooldown: CooldownEntity }
  | {
      type: "cooldown-link-failed";
      cooldown: CooldownEntity;
      message: string;
    }
  | { type: "mounted"; device: Entity }
  | { type: "reset" };

const INITIAL_STATE: MountState = {
  step: "instrument",
  busy: false,
  error: null,
};

export function mountReducer(state: MountState, action: MountAction): MountState {
  switch (action.type) {
    case "start":
      if (state.step === "success") {
        return state;
      }
      return { ...state, busy: true, error: null };
    case "fail":
      if (state.step === "success") {
        return state;
      }
      return { ...state, busy: false, error: action.message };
    case "instrument-ready":
      return {
        step: "cooldown",
        busy: false,
        error: null,
        instrument: action.instrument,
        cooldowns: action.cooldowns,
        pendingCooldown: null,
      };
    case "cooldown-selected":
      if (state.step !== "cooldown") {
        return state;
      }
      return {
        step: "device",
        busy: false,
        error: null,
        instrument: state.instrument,
        cooldown: action.cooldown,
      };
    case "cooldown-link-failed":
      if (state.step !== "cooldown") {
        return state;
      }
      return {
        ...state,
        busy: false,
        error: action.message,
        pendingCooldown: action.cooldown,
      };
    case "mounted":
      if (state.step !== "device") {
        return state;
      }
      return {
        step: "success",
        busy: false,
        error: null,
        instrument: state.instrument,
        cooldown: state.cooldown,
        device: action.device,
      };
    case "reset":
      return INITIAL_STATE;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The catalog request failed.";
}

async function listAllCooldowns(): Promise<CooldownEntity[]> {
  const cooldowns: CooldownEntity[] = [];
  let offset = 0;

  while (true) {
    const page = await listEntities<CooldownEntity>("experiment_setup", {
      limit: PAGE_SIZE,
      offset,
    });
    cooldowns.push(...page);
    if (page.length < PAGE_SIZE) {
      return cooldowns;
    }
    offset += page.length;
  }
}

async function performedOnCooldownIds(instrumentId: string): Promise<Set<string>> {
  // Query the provenance edge index for cooldowns linked PERFORMED_ON this
  // instrument (cooldown -> instrument), rather than scanning the whole
  // append-only event feed. `down` follows edges into the instrument, so the
  // reached depth-1 nodes are exactly its linked cooldowns (bead Autolab-6yw).
  const graph = await getLineageGraph(instrumentId, {
    direction: "down",
    depth: 1,
    relations: ["performed_on"],
  });
  return new Set(graph.nodes.map((node) => node.id));
}

export async function loadOpenCooldowns(
  instrumentId: string,
): Promise<CooldownEntity[]> {
  const [cooldowns, linkedCooldownIds] = await Promise.all([
    listAllCooldowns(),
    performedOnCooldownIds(instrumentId),
  ]);
  return cooldowns
    .filter(
      (cooldown) =>
        linkedCooldownIds.has(cooldown.id) &&
        (cooldown.ended_at === null || cooldown.ended_at === undefined),
    )
    .sort((left, right) => left.accession.localeCompare(right.accession));
}

function StepIndicator({ step }: { step: MountState["step"] }) {
  const activeStep = step === "instrument" ? 1 : step === "cooldown" ? 2 : 3;
  return (
    <ol className="mount-steps" aria-label="Mount progress">
      {["Instrument", "Setup", "Device"].map((label, index) => (
        <li
          className={index + 1 <= activeStep ? "mount-step--active" : undefined}
          key={label}
        >
          <span>{index + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

function EntitySummary({ entity }: { entity: Entity }) {
  return (
    <p className="entity-summary">
      <strong>{entity.accession}</strong>
      <span>{entity.name || entity.entity_type}</span>
    </p>
  );
}

export function MountPage() {
  const [state, dispatch] = useReducer(mountReducer, INITIAL_STATE);
  const [cooldownName, setCooldownName] = useState("");

  const selectInstrument = useCallback(async (accession: string) => {
    dispatch({ type: "start" });
    try {
      const { data: instrument } = await resolveAccession(accession);
      if (instrument.entity_type !== "instrument") {
        throw new Error(
          `${instrument.accession} has type ${instrument.entity_type}; expected an instrument.`,
        );
      }
      const cooldowns = await loadOpenCooldowns(instrument.id);
      dispatch({ type: "instrument-ready", instrument, cooldowns });
    } catch (error) {
      dispatch({ type: "fail", message: errorMessage(error) });
    }
  }, []);

  async function linkCooldown(cooldown: CooldownEntity, instrument: Entity) {
    dispatch({ type: "start" });
    try {
      await createEdge({
        src_id: cooldown.id,
        relation: "performed_on",
        dst_id: instrument.id,
      });
      dispatch({ type: "cooldown-selected", cooldown });
    } catch (error) {
      dispatch({
        type: "cooldown-link-failed",
        cooldown,
        message: `Setup created, but its instrument link failed: ${errorMessage(error)}`,
      });
    }
  }

  async function createCooldown(): Promise<void> {
    if (state.step !== "cooldown") {
      return;
    }
    dispatch({ type: "start" });
    try {
      const cooldown = await createEntity<CooldownEntity>("experiment_setup", {
        name:
          cooldownName.trim() ||
          `Setup on ${state.instrument.name || state.instrument.accession}`,
        started_at: new Date().toISOString(),
      });
      await linkCooldown(cooldown, state.instrument);
    } catch (error) {
      dispatch({ type: "fail", message: errorMessage(error) });
    }
  }

  const selectDevice = useCallback(
    async (accession: string) => {
      if (state.step !== "device") {
        return;
      }
      dispatch({ type: "start" });
      try {
        const { data: device } = await resolveAccession(accession);
        if (device.entity_type !== "device") {
          throw new Error(
            `${device.accession} has type ${device.entity_type}; expected a device.`,
          );
        }
        await createEdge({
          src_id: device.id,
          relation: "mounted_in",
          dst_id: state.cooldown.id,
        });
        dispatch({ type: "mounted", device });
      } catch (error) {
        dispatch({ type: "fail", message: errorMessage(error) });
      }
    },
    [state],
  );

  if (state.step === "success") {
    return (
      <section className="page-panel mount-page">
        <p className="eyebrow">Mount recorded</p>
        <h1>Device mounted</h1>
        <p className="lede">
          The device is now linked to the setup and instrument.
        </p>
        <div className="mount-success" role="status">
          {[state.device, state.cooldown, state.instrument].map((entity) => (
            <Link
              key={entity.id}
              to={`/e/${encodeURIComponent(entity.accession)}`}
            >
              <strong>{entity.accession}</strong>
              <span>{entity.name || entity.entity_type}</span>
            </Link>
          ))}
        </div>
        <button className="secondary-action" onClick={() => dispatch({ type: "reset" })}>
          Mount another device
        </button>
      </section>
    );
  }

  return (
    <section className="page-panel mount-page">
      <p className="eyebrow">Experiment setup</p>
      <h1>Mount for a run</h1>
      <p className="lede">
        Identify the instrument, choose its open setup, then identify the device.
      </p>
      <StepIndicator step={state.step} />

      {state.error ? (
        <p className="mount-error" role="alert">
          {state.error}
        </p>
      ) : null}

      {state.step === "instrument" ? (
        <section aria-labelledby="instrument-heading">
          <h2 id="instrument-heading">Scan the fridge instrument</h2>
          <AccessionScanner
            disabled={state.busy}
            inputLabel="Instrument accession"
            onAccession={selectInstrument}
            submitLabel="Use instrument"
          />
        </section>
      ) : null}

      {state.step === "cooldown" ? (
        <section aria-labelledby="cooldown-heading" className="cooldown-choice">
          <h2 id="cooldown-heading">Choose a setup</h2>
          <EntitySummary entity={state.instrument} />
          {state.cooldowns.length > 0 ? (
            <ul className="cooldown-list">
              {state.cooldowns.map((cooldown) => (
                <li key={cooldown.id}>
                  <button
                    disabled={state.busy}
                    onClick={() => dispatch({ type: "cooldown-selected", cooldown })}
                    type="button"
                  >
                    <strong>{cooldown.accession}</strong>
                    <span>{cooldown.name || "Open setup"}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">No open cooldowns are linked to this instrument.</p>
          )}

          <div className="create-cooldown">
            <label htmlFor="cooldown-name">New setup name (optional)</label>
            <div className="field-row">
              <input
                disabled={state.busy || state.pendingCooldown !== null}
                id="cooldown-name"
                onChange={(event) => setCooldownName(event.target.value)}
                placeholder={`Setup on ${state.instrument.name || state.instrument.accession}`}
                value={cooldownName}
              />
              <button
                disabled={state.busy || state.pendingCooldown !== null}
                onClick={() => void createCooldown()}
                type="button"
              >
                {state.busy ? "Working…" : "Create setup"}
              </button>
            </div>
          </div>

          {state.pendingCooldown ? (
            <button
              className="retry-action"
              disabled={state.busy}
              onClick={() => {
                if (state.pendingCooldown) {
                  void linkCooldown(state.pendingCooldown, state.instrument);
                }
              }}
              type="button"
            >
              Retry instrument link for {state.pendingCooldown.accession}
            </button>
          ) : null}
        </section>
      ) : null}

      {state.step === "device" ? (
        <section aria-labelledby="device-heading">
          <h2 id="device-heading">Scan the device</h2>
          <EntitySummary entity={state.cooldown} />
          <AccessionScanner
            disabled={state.busy}
            inputLabel="Device accession"
            onAccession={selectDevice}
            submitLabel="Mount device"
          />
        </section>
      ) : null}
    </section>
  );
}
