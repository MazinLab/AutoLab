import { useEffect, useId, useState, type ReactElement } from "react";

import { searchEntities, type SearchResult } from "../api/client";

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 8;

export interface NotifyTarget {
  id: string;
  label: string;
}

interface NotifyPickerProps {
  selected: NotifyTarget[];
  onChange: (targets: NotifyTarget[]) => void;
  disabled?: boolean;
}

/* Sender-initiated notifications: pick colleagues to DM about the record
   being created ("your data is ready"), instead of messaging them by hand. */
export function NotifyPicker({
  selected,
  onChange,
  disabled,
}: NotifyPickerProps): ReactElement {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchEntities(trimmed, SEARCH_LIMIT)
        .then((hits) => {
          if (!cancelled) {
            setResults(
              hits.filter((hit) => hit.entity_type === "person"),
            );
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResults([]);
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  function add(result: SearchResult): void {
    if (!selected.some((target) => target.id === result.id)) {
      onChange([
        ...selected,
        { id: result.id, label: result.name || result.accession },
      ]);
    }
    setQuery("");
    setResults([]);
  }

  function remove(id: string): void {
    onChange(selected.filter((target) => target.id !== id));
  }

  return (
    <div className="notify-picker">
      <label htmlFor={inputId}>Notify people</label>
      {selected.length > 0 ? (
        <ul className="notify-chips">
          {selected.map((target) => (
            <li className="notify-chip" key={target.id}>
              {target.label}
              <button
                aria-label={`Remove ${target.label}`}
                disabled={disabled}
                onClick={() => remove(target.id)}
                type="button"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        autoComplete="off"
        className="entity-search"
        disabled={disabled}
        id={inputId}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search people to DM when this is created…"
        type="search"
        value={query}
      />
      {results.length > 0 ? (
        <ul className="notify-results">
          {results.map((result) => (
            <li key={result.id}>
              <button
                disabled={disabled}
                onClick={() => add(result)}
                type="button"
              >
                {result.name || result.accession}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
