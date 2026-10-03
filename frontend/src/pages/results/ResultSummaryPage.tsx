import { type ReactElement, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  createEdge,
  deleteEdge,
  getResultSummaryTable,
  getWhoami,
  patchEntity,
  searchEntities,
  type Entity,
  type ResultColumn,
  type ResultSummaryTable,
  type SearchResult,
} from "../../api/client";
import { entityRoute } from "../entity/entityRoute";
import { formatResultValue, tableToCsv } from "./resultsTable";
import "./results.css";

interface ResultSummaryPageProps {
  summary: Entity;
  etag: string | null;
  // Called after every successful mutation: membership edges change the
  // entity page's Related records, and a PATCH bumps the header version.
  onChanged: () => void;
}

interface ColumnDraft extends ResultColumn {
  shown: boolean;
}

function draftColumns(table: ResultSummaryTable): ColumnDraft[] {
  const stored = table.summary.columns;
  if (stored.length === 0) {
    return table.keys.map((key) => ({ key, label: "", shown: true }));
  }
  const drafts: ColumnDraft[] = stored.map((column) => ({ ...column, shown: true }));
  for (const key of table.keys) {
    if (!drafts.some((column) => column.key === key)) {
      drafts.push({ key, label: "", shown: false });
    }
  }
  return drafts;
}

function swap<T>(items: T[], index: number, other: number): T[] {
  const next = [...items];
  [next[index], next[other]] = [next[other], next[index]];
  return next;
}

function AddAnalysis({
  excluded,
  onPick,
}: {
  excluded: Set<string>;
  onPick: (hit: SearchResult) => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchResult[]>([]);
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    searchEntities(text, 20)
      .then((results) => {
        if (!cancelled) {
          setHits(
            results.filter((hit) => hit.entity_type === "analysis_run" && !excluded.has(hit.id)),
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHits([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [query, excluded]);
  return (
    <div className="results-add">
      <input
        aria-label="Add analysis"
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Add analysis: search by title or accession"
        type="search"
        value={query}
      />
      {hits.length > 0 ? (
        <ul className="results-add-hits">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                className="text-button"
                onClick={() => {
                  onPick(hit);
                  setQuery("");
                  setHits([]);
                }}
                type="button"
              >
                {hit.name || hit.accession} <small>{hit.accession}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ResultSummaryPage({ summary, etag, onChanged }: ResultSummaryPageProps): ReactElement {
  const [table, setTable] = useState<ResultSummaryTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(true);
  const [editingColumns, setEditingColumns] = useState(false);
  const [drafts, setDrafts] = useState<ColumnDraft[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await getResultSummaryTable(summary.id);
      setTable(next);
      setError(null);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : "The table could not be loaded.");
    }
  }, [summary.id]);

  useEffect(() => {
    void load();
  }, [load, summary.version]);

  useEffect(() => {
    let cancelled = false;
    getWhoami()
      .then((whoami) => {
        if (!cancelled && whoami.can_write === false) {
          setCanWrite(false);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(action: () => Promise<unknown>): Promise<void> {
    setIsSaving(true);
    try {
      await action();
      await load();
      onChanged();
    } catch (actionError: unknown) {
      setError(actionError instanceof Error ? actionError.message : "The change failed.");
    } finally {
      setIsSaving(false);
    }
  }

  function download(): void {
    if (!table) {
      return;
    }
    const blob = new Blob([tableToCsv(table)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${summary.accession}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (error && !table) {
    return <p className="form-message form-message--error">{error}</p>;
  }
  if (!table) {
    return <p className="empty-state">Loading table…</p>;
  }
  const memberIds = new Set(table.rows.map((row) => row.analysis.id));
  const updateDraft = (index: number, patch: Partial<ColumnDraft>): void =>
    setDrafts((current) => current.map((column, i) => (i === index ? { ...column, ...patch } : column)));

  return (
    <div className="results-page">
      <div className="results-toolbar">
        {canWrite ? (
          <AddAnalysis
            excluded={memberIds}
            onPick={(hit) =>
              void run(() => createEdge({ src_id: hit.id, relation: "refers_to", dst_id: summary.id }))
            }
          />
        ) : null}
        <span className="spacer" />
        {canWrite ? (
          <button
            className="secondary-button"
            onClick={() => {
              setDrafts(draftColumns(table));
              setEditingColumns((open) => !open);
            }}
            type="button"
          >
            Columns
          </button>
        ) : null}
        <button
          className="secondary-button"
          disabled={table.rows.length === 0}
          onClick={download}
          type="button"
        >
          Download CSV
        </button>
      </div>
      {error ? <p className="form-message form-message--error">{error}</p> : null}
      {editingColumns && canWrite ? (
        <form
          className="results-columns"
          onSubmit={(event) => {
            event.preventDefault();
            const columns = drafts
              .filter((column) => column.shown)
              .map(({ key, label }) => ({ key, label }));
            void run(async () => {
              await patchEntity("result_summary", summary.id, { columns }, etag ?? undefined);
              setEditingColumns(false);
            });
          }}
        >
          {drafts.map((column, index) => (
            <div className="results-columns-row" key={column.key}>
              <input
                aria-label={`Show ${column.key}`}
                checked={column.shown}
                onChange={(event) => updateDraft(index, { shown: event.target.checked })}
                type="checkbox"
              />
              <code>{column.key}</code>
              <input
                aria-label={`Label for ${column.key}`}
                onChange={(event) => updateDraft(index, { label: event.target.value })}
                placeholder={column.key}
                type="text"
                value={column.label}
              />
              <button
                aria-label={`Move ${column.key} up`}
                className="icon-button"
                disabled={index === 0}
                onClick={() => setDrafts((current) => swap(current, index, index - 1))}
                type="button"
              >
                ↑
              </button>
              <button
                aria-label={`Move ${column.key} down`}
                className="icon-button"
                disabled={index === drafts.length - 1}
                onClick={() => setDrafts((current) => swap(current, index, index + 1))}
                type="button"
              >
                ↓
              </button>
            </div>
          ))}
          <div className="results-columns-actions">
            {/* An empty list would silently restore union mode; that is what Reset is for. */}
            <button
              className="primary-button"
              disabled={isSaving || !drafts.some((column) => column.shown)}
              type="submit"
            >
              Save columns
            </button>
            <button
              className="text-button"
              disabled={isSaving}
              onClick={() =>
                void run(async () => {
                  await patchEntity("result_summary", summary.id, { columns: [] }, etag ?? undefined);
                  setEditingColumns(false);
                })
              }
              type="button"
            >
              Reset to all keys
            </button>
          </div>
        </form>
      ) : null}
      <div className="catalog-table-wrap results-table-wrap">
        <table aria-label="Result summary table" className="catalog-table results-table">
          <thead>
            <tr>
              <th>Analysis</th>
              <th>Project</th>
              <th>Experiment</th>
              <th>Date</th>
              {table.columns.map((column) => (
                <th className="results-cell--number" key={column.key} title={column.key}>
                  {column.label}
                </th>
              ))}
              {canWrite ? <th aria-label="Actions" /> : null}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.analysis.id}>
                <td>
                  <Link to={entityRoute(row.analysis.id)}>{row.analysis.name || row.analysis.accession}</Link>
                  <small> {row.analysis.accession}</small>
                </td>
                <td>{row.project ? <Link to={entityRoute(row.project.id)}>{row.project.name}</Link> : null}</td>
                <td>
                  {row.experiment ? (
                    <Link to={entityRoute(row.experiment.id)}>{row.experiment.name}</Link>
                  ) : null}
                </td>
                <td>{new Date(row.analysis.created_at).toLocaleDateString()}</td>
                {table.columns.map((column) => {
                  const value = row.results[column.key];
                  return (
                    <td
                      className={typeof value === "number" ? "results-cell--number" : undefined}
                      key={column.key}
                      title={value === undefined ? undefined : String(value)}
                    >
                      {formatResultValue(value)}
                    </td>
                  );
                })}
                {canWrite ? (
                  <td>
                    <button
                      aria-label={`Remove ${row.analysis.name || row.analysis.accession}`}
                      className="icon-button icon-button--danger"
                      disabled={isSaving}
                      onClick={() =>
                        void run(() =>
                          deleteEdge({ src_id: row.analysis.id, relation: "refers_to", dst_id: summary.id }),
                        )
                      }
                      type="button"
                    >
                      ×
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        {table.rows.length === 0 ? (
          <p className="empty-state results-empty">
            No analyses yet.{" "}
            {canWrite ? "Search above to add one, or pick this summary on an Analysis." : ""}
          </p>
        ) : null}
      </div>
    </div>
  );
}
