import { type ReactElement, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  ApiError,
  getEntity,
  getEntityEvents,
  listEntitiesPage,
  patchEntity,
  type Entity,
  type EventRecord,
} from "../../api/client";

interface ReviewTask extends Entity {
  kind?: string;
  status?: string;
}

interface QueueItem {
  etag: string | null;
  provenanceLinks: TaskProvenanceLinks | null;
  task: ReviewTask;
}

interface EvidenceLink {
  key: string;
  label: string;
  to: string;
}

interface TaskProvenanceLinks {
  evidence: EvidenceLink[];
  targets: EvidenceLink[];
}

type ReviewDecision = "dismissed" | "resolved";

const PAGE_SIZE = 50;
// A review task carries a handful of provenance edges; one bounded page of
// its own event stream is more than enough to reconstruct them.
const TASK_EVENT_LIMIT = 200;

function taskStatus(task: ReviewTask): string {
  const extraStatus = task.extra.status;
  return task.status ?? (typeof extraStatus === "string" ? extraStatus : "open");
}

function legacyEvidenceLinks(task: ReviewTask): EvidenceLink[] {
  const evidence = task.extra.evidence ?? task.extra.evidence_ids;
  if (!Array.isArray(evidence)) {
    return [];
  }

  return evidence.flatMap((item, index) => {
    if (typeof item === "string" && item) {
      return [
        {
          key: `${item}-${index}`,
          label: item,
          to: `/entity/${encodeURIComponent(item)}`,
        },
      ];
    }
    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const accession =
      typeof record.accession === "string" ? record.accession : null;
    const name = typeof record.name === "string" ? record.name : null;
    if (!id && !accession) {
      return [];
    }
    return [
      {
        key: `${id ?? accession}-${index}`,
        label: name
          ? `${name}${accession ? ` (${accession})` : ""}`
          : (accession ?? id ?? "Evidence"),
        to: accession
          ? `/e/${encodeURIComponent(accession)}`
          : `/entity/${encodeURIComponent(id ?? "")}`,
      },
    ];
  });
}

function provenanceFromEvents(events: EventRecord[]): TaskProvenanceLinks {
  const links: TaskProvenanceLinks = { evidence: [], targets: [] };

  for (const event of events) {
    if (event.action !== "linked") {
      continue;
    }
    const destinationId = event.payload.dst_id;
    const relation = event.payload.relation;
    if (
      typeof destinationId !== "string" ||
      (relation !== "annotates" && relation !== "refers_to")
    ) {
      continue;
    }

    const link: EvidenceLink = {
      key: `${relation}-${destinationId}`,
      label: destinationId,
      to: `/entity/${encodeURIComponent(destinationId)}`,
    };
    const relatedLinks = relation === "annotates" ? links.targets : links.evidence;
    if (!relatedLinks.some((candidate) => candidate.to === link.to)) {
      relatedLinks.push(link);
    }
  }

  return links;
}

export function ReviewQueuePage(): ReactElement {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provenanceError, setProvenanceError] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [activeTaskIds, setActiveTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [notification, setNotification] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setProvenanceError(null);
    void listEntitiesPage<ReviewTask>("review_task", {
      filters: { status: "open" },
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      order: "desc",
    })
      .then(async (listed) => {
        if (cancelled) {
          return;
        }
        if (listed.rows.length === 0 && page > 0) {
          // The last task on this page was resolved elsewhere; step back.
          setPage((current) => Math.max(0, current - 1));
          return;
        }
        setTotal(listed.total);
        // Refetch each visible task individually for its ETag (concurrency
        // safe PATCH) — bounded by the page size.
        const loadedTasks = await Promise.all(
          listed.rows.map((task) => getEntity<ReviewTask>("review_task", task.id)),
        );
        if (cancelled) {
          return;
        }
        const openItems = loadedTasks
          .filter((loaded) => taskStatus(loaded.data) === "open")
          .map((loaded) => ({
            etag: loaded.etag,
            provenanceLinks: null,
            task: loaded.data,
          }));
        setItems(openItems);

        // Provenance from each task's own bounded event stream — never the
        // full event log.
        void Promise.all(
          openItems.map(async (item) => ({
            links: provenanceFromEvents(
              (
                await getEntityEvents(item.task.id, { limit: TASK_EVENT_LIMIT })
              ).events,
            ),
            taskId: item.task.id,
          })),
        )
          .then((results) => {
            if (cancelled) {
              return;
            }
            const linksByTask = new Map(
              results.map((result) => [result.taskId, result.links]),
            );
            setItems(
              (current) =>
                current?.map((item) => ({
                  ...item,
                  provenanceLinks: linksByTask.get(item.task.id) ?? {
                    evidence: [],
                    targets: [],
                  },
                })) ?? null,
            );
          })
          .catch((error: unknown) => {
            if (!cancelled) {
              setProvenanceError(
                error instanceof Error
                  ? error.message
                  : "Linked records could not be loaded.",
              );
            }
          });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Review tasks could not be loaded.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [page, reloadTick]);

  async function decide(item: QueueItem, decision: ReviewDecision): Promise<void> {
    setNotification(null);
    setActionErrors((current) => ({ ...current, [item.task.id]: "" }));
    if (!item.etag) {
      setActionErrors((current) => ({
        ...current,
        [item.task.id]: "Unable to update safely: the server did not provide an ETag.",
      }));
      return;
    }

    setActiveTaskIds((current) => {
      const next = new Set(current);
      next.add(item.task.id);
      return next;
    });
    try {
      await patchEntity(
        "review_task",
        item.task.id,
        { status: decision },
        item.etag,
      );
      setNotification(`Review task ${decision}.`);
      // Refresh the current page so the next open task slides in.
      setReloadTick((current) => current + 1);
    } catch (error: unknown) {
      setActionErrors((current) => ({
        ...current,
        [item.task.id]:
          error instanceof ApiError && error.status === 412
            ? "changed elsewhere, reload"
            : error instanceof Error
              ? error.message
              : "The review task could not be updated.",
      }));
    } finally {
      setActiveTaskIds((current) => {
        const next = new Set(current);
        next.delete(item.task.id);
        return next;
      });
    }
  }

  const rangeStart = page * PAGE_SIZE + 1;
  const rangeEnd = page * PAGE_SIZE + (items?.length ?? 0);
  const hasNextPage = page * PAGE_SIZE + PAGE_SIZE < total;

  return (
    <section className="page-panel queue-page">
      <p className="eyebrow">Review</p>
      <h1>Review queue</h1>
      <p className="lede">
        Resolve proposed annotations and catalog issues with concurrency-safe
        decisions.
      </p>

      {loadError ? (
        <p className="form-message form-message--error">{loadError}</p>
      ) : null}
      {provenanceError ? (
        <p className="form-message form-message--error">
          Linked targets and evidence could not be loaded: {provenanceError}
        </p>
      ) : null}
      {!items && !loadError ? <p className="loading-message">Loading queue…</p> : null}
      {notification ? (
        <p aria-live="polite" className="form-message form-message--success">
          {notification}
        </p>
      ) : null}
      {items?.length === 0 ? (
        <div className="empty-state">
          <h2>Queue clear</h2>
          <p>There are no open review tasks.</p>
        </div>
      ) : null}
      {items && items.length > 0 ? (
        <>
          <div className="review-list">
            {items.map((item) => {
              const targets = item.provenanceLinks?.targets ?? [];
              const evidence =
                item.provenanceLinks?.evidence.length
                  ? item.provenanceLinks.evidence
                  : legacyEvidenceLinks(item.task);
              const isActive = activeTaskIds.has(item.task.id);
              return (
                <article className="review-card" key={item.task.id}>
                  <div className="review-card__heading">
                    <div>
                      <p className="review-kind">
                        {item.task.kind || "review task"}
                      </p>
                      <h2>{item.task.name || item.task.accession}</h2>
                    </div>
                    <span>{item.task.accession}</span>
                  </div>
                  {item.task.description ? <p>{item.task.description}</p> : null}
                  <div className="evidence-links">
                    <strong>Annotation target</strong>
                    {targets.length > 0 ? (
                      <ul>
                        {targets.map((link) => (
                          <li key={link.key}>
                            <Link to={link.to}>{link.label}</Link>
                          </li>
                        ))}
                      </ul>
                    ) : item.provenanceLinks ? (
                      <span>No annotation target</span>
                    ) : (
                      <span>Loading linked target…</span>
                    )}
                  </div>
                  <div className="evidence-links">
                    <strong>Evidence</strong>
                    {evidence.length > 0 ? (
                      <ul>
                        {evidence.map((link) => (
                          <li key={link.key}>
                            <Link to={link.to}>{link.label}</Link>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span>No linked evidence</span>
                    )}
                  </div>
                  {actionErrors[item.task.id] ? (
                    <p aria-live="polite" className="form-message form-message--error">
                      {actionErrors[item.task.id]}
                    </p>
                  ) : null}
                  <div className="review-actions">
                    <button
                      className="primary-button"
                      disabled={isActive}
                      onClick={() => void decide(item, "resolved")}
                      type="button"
                    >
                      Resolve
                    </button>
                    <button
                      className="secondary-button"
                      disabled={isActive}
                      onClick={() => void decide(item, "dismissed")}
                      type="button"
                    >
                      Dismiss
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          <nav aria-label="Pagination" className="table-pager">
            <button
              className="secondary-button"
              disabled={page === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              type="button"
            >
              Previous
            </button>
            <span className="table-pager__range">
              {rangeStart}–{rangeEnd} of {total} open task{total === 1 ? "" : "s"}
            </span>
            <button
              className="secondary-button"
              disabled={!hasNextPage}
              onClick={() => setPage((current) => current + 1)}
              type="button"
            >
              Next
            </button>
          </nav>
        </>
      ) : null}
    </section>
  );
}
