import { type ReactElement, useState } from "react";

import type { ResultValue } from "../api/client";

// Mirrors labcore/results.py: units ride in the key name (base_temp_mk).
export const RESULT_KEY_RE = /^[A-Za-z0-9_./%+-]+$/;
const NUMERIC_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export function parseResultValue(raw: string): ResultValue {
  const text = raw.trim();
  if (text !== "" && NUMERIC_RE.test(text)) {
    const parsed = Number(text);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return text;
}

interface Row {
  id: number;
  key: string;
  raw: string;
}

interface ResultsFieldEditorProps {
  value: Record<string, ResultValue>;
  onChange: (next: Record<string, ResultValue>) => void;
  disabled?: boolean;
}

function rowsFrom(value: Record<string, ResultValue>): Row[] {
  return Object.entries(value).map(([key, entry], index) => ({
    id: index,
    key,
    raw: String(entry),
  }));
}

function rowProblem(row: Row, rows: Row[]): string | null {
  if (!RESULT_KEY_RE.test(row.key)) {
    return "Keys use letters, digits and _ . / % + - only; put units in the name (base_temp_mk).";
  }
  if (rows.some((other) => other.id !== row.id && other.key === row.key)) {
    return `${row.key} is already listed.`;
  }
  if (row.raw.trim() === "") {
    return "Enter a value.";
  }
  return null;
}

function toMap(rows: Row[]): Record<string, ResultValue> {
  const map: Record<string, ResultValue> = {};
  for (const row of rows) {
    if (rowProblem(row, rows) === null) {
      map[row.key] = parseResultValue(row.raw);
    }
  }
  return map;
}

export function ResultsFieldEditor({
  value,
  onChange,
  disabled = false,
}: ResultsFieldEditorProps): ReactElement {
  // Drafts are seeded once from `value`; afterwards the editor owns them and
  // reports the valid subset upward, so what is displayed is what is saved.
  const [rows, setRows] = useState<Row[]>(() => rowsFrom(value));
  const [nextId, setNextId] = useState(() => Object.keys(value).length);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newError, setNewError] = useState<string | null>(null);

  function commit(next: Row[]): void {
    setRows(next);
    onChange(toMap(next));
  }

  function add(): void {
    const candidate: Row = { id: nextId, key: newKey.trim(), raw: newValue };
    const problem = rowProblem(candidate, [...rows, candidate]);
    if (problem) {
      setNewError(problem);
      return;
    }
    setNewError(null);
    setNextId(nextId + 1);
    setNewKey("");
    setNewValue("");
    commit([...rows, candidate]);
  }

  return (
    <div className="results-editor">
      {rows.map((row) => {
        const problem = rowProblem(row, rows);
        return (
          <div className="results-editor-row" key={row.id}>
            <input
              aria-label={`Key for ${row.key || "new row"}`}
              className={problem?.startsWith("Keys") ? "results-editor-invalid" : undefined}
              disabled={disabled}
              onChange={(event) =>
                commit(
                  rows.map((r) =>
                    r.id === row.id ? { ...r, key: event.target.value.trim() } : r,
                  ),
                )
              }
              type="text"
              value={row.key}
            />
            <input
              aria-label={`Value for ${row.key}`}
              disabled={disabled}
              onChange={(event) =>
                commit(rows.map((r) => (r.id === row.id ? { ...r, raw: event.target.value } : r)))
              }
              type="text"
              value={row.raw}
            />
            <button
              aria-label={`Remove ${row.key}`}
              className="icon-button icon-button--danger"
              disabled={disabled}
              onClick={() => commit(rows.filter((r) => r.id !== row.id))}
              type="button"
            >
              ×
            </button>
            {problem ? (
              <p className="form-message form-message--error results-editor-problem">{problem}</p>
            ) : null}
          </div>
        );
      })}
      <div className="results-editor-row results-editor-row--new">
        <input
          aria-label="New result key"
          disabled={disabled}
          onChange={(event) => setNewKey(event.target.value)}
          placeholder="key (e.g. base_temp_mk)"
          type="text"
          value={newKey}
        />
        <input
          aria-label="New result value"
          disabled={disabled}
          onChange={(event) => setNewValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder="value"
          type="text"
          value={newValue}
        />
        <button className="text-button" disabled={disabled} onClick={add} type="button">
          Add result
        </button>
        {newError ? (
          <p className="form-message form-message--error results-editor-problem">{newError}</p>
        ) : null}
      </div>
    </div>
  );
}
