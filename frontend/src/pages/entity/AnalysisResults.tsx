import { type ReactElement, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  createEdge,
  deleteEdge,
  patchEntity,
  searchEntities,
  type Entity,
  type LineageNode,
  type ResultValue,
  type SearchResult,
} from "../../api/client";
import { ResultsFieldEditor } from "../../components/ResultsFieldEditor";
import { formatResultValue } from "../results/resultsTable";
import { entityRoute } from "./entityRoute";
import "../results/results.css";

interface AnalysisResultsProps {
  analysis: Entity;
  etag: string | null;
  // result_summary nodes this analysis refers to (from the page's depth-1 graph).
  summaries: LineageNode[];
  canWrite: boolean;
  onChanged: () => void;
}

function resultsOf(entity: Entity): Record<string, ResultValue> {
  const raw = entity.results;
  if (!raw || typeof raw !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, ResultValue] =>
        typeof entry[1] === "number" || typeof entry[1] === "string",
    ),
  );
}

export function AnalysisResults({
  analysis,
  etag,
  summaries,
  canWrite,
  onChanged,
}: AnalysisResultsProps): ReactElement {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, ResultValue>>(() => resultsOf(analysis));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchResult[]>([]);
  const results = resultsOf(analysis);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const joined = new Set(summaries.map((summary) => summary.id));
    searchEntities(text, 20)
      .then((found) => {
        if (!cancelled) {
          setHits(found.filter((hit) => hit.entity_type === "result_summary" && !joined.has(hit.id)));
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
  }, [query, summaries]);

  async function save(): Promise<void> {
    setIsSaving(true);
    try {
      await patchEntity("analysis_run", analysis.id, { results: draft }, etag ?? undefined);
      setIsEditing(false);
      setError(null);
      onChanged();
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : "Saving failed.");
    } finally {
      setIsSaving(false);
    }
  }

  async function join(hit: SearchResult): Promise<void> {
    try {
      await createEdge({ src_id: analysis.id, relation: "refers_to", dst_id: hit.id });
      setQuery("");
      setHits([]);
      setError(null);
      onChanged();
    } catch (joinError: unknown) {
      setError(joinError instanceof Error ? joinError.message : "Linking failed.");
    }
  }

  async function leave(summary: LineageNode): Promise<void> {
    try {
      await deleteEdge({ src_id: analysis.id, relation: "refers_to", dst_id: summary.id });
      setError(null);
      onChanged();
    } catch (leaveError: unknown) {
      setError(leaveError instanceof Error ? leaveError.message : "Unlinking failed.");
    }
  }

  return (
    <section className="entity-section" aria-labelledby="analysis-results-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Numbers</p>
          <h2 id="analysis-results-heading">Results</h2>
        </div>
        {canWrite && !isEditing ? (
          <button
            className="secondary-button"
            onClick={() => {
              setDraft(results);
              setIsEditing(true);
            }}
            type="button"
          >
            Edit results
          </button>
        ) : null}
      </div>
      {isEditing && canWrite ? (
        <div className="analysis-results-editor">
          <ResultsFieldEditor disabled={isSaving} onChange={setDraft} value={draft} />
          <div className="analysis-results-actions">
            <button className="primary-button" disabled={isSaving} onClick={() => void save()} type="button">
              Save results
            </button>
            <button
              className="text-button"
              disabled={isSaving}
              onClick={() => setIsEditing(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : Object.keys(results).length > 0 ? (
        <table className="analysis-results-table">
          <tbody>
            {Object.entries(results).map(([key, value]) => (
              <tr key={key}>
                <th scope="row">
                  <code>{key}</code>
                </th>
                <td
                  className={typeof value === "number" ? "results-cell--number" : undefined}
                  title={String(value)}
                >
                  {formatResultValue(value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty-state">No results recorded.</p>
      )}
      {error ? <p className="form-message form-message--error">{error}</p> : null}

      <h3 className="analysis-summaries-heading">Result summaries</h3>
      {summaries.length > 0 ? (
        <ul className="linked-records">
          {summaries.map((summary) => (
            <li key={summary.id}>
              <Link to={entityRoute(summary.id)}>
                <strong>{summary.name || summary.accession}</strong>
                <small>{summary.accession}</small>
              </Link>
              {canWrite ? (
                <span className="linked-record-actions">
                  <button
                    aria-label={`Leave ${summary.name || summary.accession}`}
                    className="text-button"
                    onClick={() => void leave(summary)}
                    type="button"
                  >
                    Leave
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">Not in any result summary.</p>
      )}
      {canWrite ? (
        <div className="results-add">
          <input
            aria-label="Add to summary"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Add to summary: search by title"
            type="search"
            value={query}
          />
          {hits.length > 0 ? (
            <ul className="results-add-hits">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button className="text-button" onClick={() => void join(hit)} type="button">
                    {hit.name || hit.accession} <small>{hit.accession}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
