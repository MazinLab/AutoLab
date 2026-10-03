import { type ReactElement, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  ENTITY_TYPES,
  getFeed,
  isEntityType,
  listEntities,
  type Entity,
  type FeedItem,
  type FeedQuery,
} from "../../api/client";

const PAGE_SIZE = 50;
const ACTION_OPTIONS = [
  "created",
  "updated",
  "linked",
  "unlinked",
  "deleted",
] as const;
// created + updated is "progress"; linked events fire for every provenance
// edge and would drown the feed, so they are opt-in.
const DEFAULT_ACTIONS: string[] = ["created", "updated"];

// The date inputs pick LOCAL days; the server compares instants (naive
// values read as UTC). Convert the local day boundaries to ISO instants so
// the filtered window matches the user's calendar day in any timezone.
function localDayStart(date: string): string {
  // `YYYY-MM-DDT00:00:00` without a zone parses as local time.
  return new Date(`${date}T00:00:00`).toISOString();
}

function localDayEnd(date: string): string {
  const nextMidnight = new Date(`${date}T00:00:00`);
  nextMidnight.setDate(nextMidnight.getDate() + 1);
  // Last representable instant of the local day: next midnight minus 1 ms.
  return new Date(nextMidnight.getTime() - 1).toISOString();
}

function dayOf(item: FeedItem): string {
  return new Date(item.at).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function timeOf(item: FeedItem): string {
  return new Date(item.at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function payloadText(item: FeedItem, key: string): string | null {
  const value = item.payload[key];
  return typeof value === "string" && value ? value : null;
}

function itemHeadline(item: FeedItem): string {
  if (item.entity === null) {
    return (
      // Deleted (and unlinked-to-deleted) entities are gone from the catalog;
      // the event payload still carries their identity.
      payloadText(item, "name") ??
      payloadText(item, "accession") ??
      "(entity no longer resolvable)"
    );
  }
  return item.entity.name || item.entity.accession;
}

export function ActivityPage(): ReactElement {
  const [actions, setActions] = useState<string[]>(DEFAULT_ACTIONS);
  const [entityType, setEntityType] = useState("");
  const [actor, setActor] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [actorChoices, setActorChoices] = useState<Entity[]>([]);
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const filterQuery = useMemo((): FeedQuery => {
    return {
      limit: PAGE_SIZE,
      actions: actions.join(","),
      ...(entityType && isEntityType(entityType) ? { entityType } : {}),
      ...(actor ? { actor } : {}),
      ...(fromDate ? { since: localDayStart(fromDate) } : {}),
      ...(toDate ? { until: localDayEnd(toDate) } : {}),
    };
  }, [actions, actor, entityType, fromDate, toDate]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      listEntities("person", { limit: 100 }),
      listEntities("agent", { limit: 100 }),
    ])
      .then(([people, agents]) => {
        if (!cancelled) {
          setActorChoices([...people, ...agents]);
        }
      })
      .catch(() => {
        // The actor filter is optional; the feed still works without it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setNextCursor(null);
    setLoadError(null);
    void getFeed(filterQuery)
      .then((page) => {
        if (!cancelled) {
          setItems(page.items);
          setNextCursor(page.next_cursor);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Activity could not be loaded.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filterQuery]);

  function toggleAction(action: string): void {
    setActions((current) => {
      if (current.includes(action)) {
        // Keep at least one action selected: an empty selection would either
        // show nothing or silently mean "everything".
        return current.length === 1
          ? current
          : current.filter((candidate) => candidate !== action);
      }
      return ACTION_OPTIONS.filter(
        (candidate) => current.includes(candidate) || candidate === action,
      );
    });
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await getFeed({ ...filterQuery, before: nextCursor });
      setItems((existing) => [...(existing ?? []), ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (error: unknown) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "More activity could not be loaded.",
      );
    } finally {
      setLoadingMore(false);
    }
  }

  let lastDay = "";

  return (
    <section className="page-panel activity-page">
      <p className="eyebrow">Activity</p>
      <h1>Latest progress</h1>
      <p className="lede">
        Catalog activity, newest first. Filter by action, record type, or
        actor.
      </p>

      <div className="activity-filters">
        <fieldset className="activity-filter-group activity-filter-actions">
          <legend>Actions</legend>
          <div className="action-toggles">
            {ACTION_OPTIONS.map((action) => {
              const isSelected = actions.includes(action);
              return (
                <button
                  aria-pressed={isSelected}
                  className={`action-toggle${
                    isSelected ? " action-toggle--active" : ""
                  }`}
                  key={action}
                  onClick={() => toggleAction(action)}
                  type="button"
                >
                  {action}
                </button>
              );
            })}
          </div>
        </fieldset>
        <label className="activity-filter-group" htmlFor="activity-type-filter">
          Record type
          <select
            id="activity-type-filter"
            onChange={(event) => setEntityType(event.target.value)}
            value={entityType}
          >
            <option value="">Any type</option>
            {ENTITY_TYPES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="activity-filter-group" htmlFor="activity-actor-filter">
          Actor
          <select
            id="activity-actor-filter"
            onChange={(event) => setActor(event.target.value)}
            value={actor}
          >
            <option value="">Anyone</option>
            {actorChoices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.name || choice.accession}
              </option>
            ))}
          </select>
        </label>
        <label className="activity-filter-group" htmlFor="activity-from-filter">
          From
          <input
            id="activity-from-filter"
            onChange={(event) => setFromDate(event.target.value)}
            type="date"
            value={fromDate}
          />
        </label>
        <label className="activity-filter-group" htmlFor="activity-to-filter">
          To
          <input
            id="activity-to-filter"
            onChange={(event) => setToDate(event.target.value)}
            type="date"
            value={toDate}
          />
        </label>
      </div>

      {loadError ? (
        <p className="form-message form-message--error">{loadError}</p>
      ) : null}
      {!items && !loadError ? (
        <p className="loading-message">Loading activity…</p>
      ) : null}
      {items && items.length === 0 ? (
        <div className="empty-state">
          <p>No catalog activity matches these filters.</p>
        </div>
      ) : null}

      {items && items.length > 0 ? (
        <ol className="activity-feed">
          {items.map((item) => {
            const day = dayOf(item);
            const showDay = day !== lastDay;
            lastDay = day;
            const relation = payloadText(item, "relation");
            const relationTarget = payloadText(item, "dst_id");
            const payloadType = payloadText(item, "entity_type");
            const payloadAccession = payloadText(item, "accession");
            return (
              <li className="activity-item" key={item.id}>
                {showDay ? (
                  <h2 className="activity-day">{day}</h2>
                ) : null}
                <div className="activity-row">
                  <time className="activity-time" dateTime={item.at}>
                    {timeOf(item)}
                  </time>
                  <span
                    className={`activity-action activity-action--${item.action}`}
                  >
                    {item.action}
                  </span>
                  {item.entity ? (
                    <>
                      <span className="activity-type">
                        {item.entity.entity_type.replaceAll("_", " ")}
                      </span>
                      <Link
                        className="activity-entity"
                        to={`/entity/${item.entity.id}`}
                      >
                        {itemHeadline(item)}
                      </Link>
                      <span className="activity-accession">
                        {item.entity.accession}
                      </span>
                    </>
                  ) : (
                    <>
                      {payloadType ? (
                        <span className="activity-type">
                          {payloadType.replaceAll("_", " ")}
                        </span>
                      ) : null}
                      <span className="activity-entity">
                        {itemHeadline(item)}
                      </span>
                      {payloadAccession &&
                      itemHeadline(item) !== payloadAccession ? (
                        <span className="activity-accession">
                          {payloadAccession}
                        </span>
                      ) : null}
                    </>
                  )}
                  {(item.action === "linked" || item.action === "unlinked") &&
                  relation ? (
                    <span className="activity-relation">
                      {relation}
                      {relationTarget ? ` → ${relationTarget}` : ""}
                    </span>
                  ) : null}
                  {item.actor ? (
                    <span className="activity-actor">
                      by {item.actor.name || item.actor.accession}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      {nextCursor ? (
        <button
          className="secondary-button"
          disabled={loadingMore}
          onClick={() => void loadMore()}
          type="button"
        >
          {loadingMore ? "Loading…" : "Load older activity"}
        </button>
      ) : null}
    </section>
  );
}
