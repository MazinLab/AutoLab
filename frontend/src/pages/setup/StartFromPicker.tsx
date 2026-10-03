import { type ReactElement, useEffect, useId, useState } from "react";

import {
  getEntity,
  getLineageGraph,
  getSetupLayout,
  type Entity,
  type Layout,
  type SearchResult,
} from "../../api/client";
import { cloneLayout, defaultLayout, isEmptyLayout } from "./rfLayout";

export interface StartFromChoice {
  key: string;
  label: string;
  layout: Layout;
}

interface StartFromPickerProps {
  testbed: SearchResult | null;
  disabled: boolean;
  // A clone's layout: shown as the selected "Cloned from" option and never
  // replaced by a late default fetch.
  cloned?: { layout: Layout; sourceAccession: string } | null;
  onChange: (choice: StartFromChoice | null) => void;
}

const PREVIOUS_LIMIT = 20;

function baseTempK(record: Entity | null): number | null {
  const value = record?.extra?.base_temp_mk;
  return typeof value === "number" && value > 0 ? value / 1000 : null;
}

/* The layout a new setup starts from: the testbed's stored default, one
   of its previous setups, or a clone. Fetches happen on demand so an
   untouched form makes no layout requests. */
export function StartFromPicker({
  testbed,
  disabled,
  cloned = null,
  onChange,
}: StartFromPickerProps): ReactElement | null {
  const selectId = useId();
  const [options, setOptions] = useState<{ key: string; label: string; setupId?: string }[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>(cloned ? "clone" : "default");
  const [testbedRecord, setTestbedRecord] = useState<Entity | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cloned) {
      onChange({ key: "clone", label: `Cloned from ${cloned.sourceAccession}`, layout: cloned.layout });
    }
    // Mount only: the clone is fixed for the form's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!testbed) {
      setOptions([]);
      setTestbedRecord(null);
      if (!cloned) {
        onChange(null);
      }
      return;
    }
    let cancelled = false;
    setError(null);
    Promise.all([
      getEntity("instrument", testbed.id),
      getLineageGraph(testbed.id, {
        direction: "down",
        depth: 1,
        relations: ["performed_on"],
        hydrate: true,
      }),
    ])
      .then(async ([record, graph]) => {
        if (cancelled) {
          return;
        }
        setTestbedRecord(record.data);
        const setupNodes = graph.nodes.filter((node) => node.entity_type === "experiment_setup");
        const setups = await Promise.all(
          setupNodes.slice(0, PREVIOUS_LIMIT * 2).map((node) =>
            getEntity("experiment_setup", node.id)
              .then((response) => response.data)
              .catch(() => null),
          ),
        );
        if (cancelled) {
          return;
        }
        const previous = setups
          .filter((setup): setup is Entity => setup !== null && !isEmptyLayout(setup.layout))
          .sort((a, b) => String(b.started_at ?? b.created_at).localeCompare(String(a.started_at ?? a.created_at)))
          .slice(0, PREVIOUS_LIMIT)
          .map((setup) => ({
            key: `setup:${setup.id}`,
            setupId: setup.id,
            label: `${setup.name || setup.accession} (${new Date(String(setup.started_at ?? setup.created_at)).toLocaleDateString()})`,
          }));
        setOptions([{ key: "default", label: "Testbed default" }, ...previous]);
        // The default resolves as soon as the testbed is known, unless a
        // clone or an earlier explicit pick is in place.
        if (!cloned && selectedKey === "default") {
          onChange({
            key: "default",
            label: "Testbed default",
            layout: defaultFor(record.data),
          });
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Previous setups could not be loaded.");
        }
      });
    return () => {
      cancelled = true;
    };
    // Re-run only when the picked testbed changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testbed?.id]);

  function defaultFor(record: Entity): Layout {
    const stored = isEmptyLayout(record.default_layout) ? null : (record.default_layout as Layout);
    return stored ? cloneLayout(stored) : defaultLayout(String(record.kind ?? "") || null, baseTempK(record));
  }

  async function choose(key: string): Promise<void> {
    setSelectedKey(key);
    setError(null);
    if (key === "clone" && cloned) {
      onChange({ key, label: `Cloned from ${cloned.sourceAccession}`, layout: cloned.layout });
      return;
    }
    if (key === "default") {
      onChange(testbedRecord ? { key, label: "Testbed default", layout: defaultFor(testbedRecord) } : null);
      return;
    }
    const option = options.find((candidate) => candidate.key === key);
    if (!option?.setupId) {
      onChange(null);
      return;
    }
    try {
      const result = await getSetupLayout(option.setupId);
      onChange({ key, label: option.label, layout: cloneLayout(result.data.layout as Layout) });
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : "That setup's layout could not be loaded.");
      onChange(null);
    }
  }

  if (!testbed && !cloned) {
    return null;
  }
  return (
    <div className="template-field">
      <label htmlFor={selectId}>Start from</label>
      <select
        disabled={disabled}
        id={selectId}
        onChange={(event) => void choose(event.target.value)}
        value={selectedKey}
      >
        {cloned ? <option value="clone">Cloned from {cloned.sourceAccession}</option> : null}
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}
