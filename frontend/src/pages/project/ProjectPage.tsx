import { type FormEvent, type ReactElement, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  createProjectItem,
  deleteProjectItem,
  getProjectReport,
  patchProjectItem,
  reorderProjectItems,
  setProjectItemDone,
  type Entity,
  type EventRecord,
  type ProjectItem,
  type ProjectItemKind,
  type ProjectReport,
} from "../../api/client";
import { EntityEditor } from "../entity/EntityEditor";
import { entityRoute } from "../entity/entityRoute";
import "./project.css";

interface ProjectPageProps {
  entity: Entity;
  etag: string | null;
  // Called after the project record itself changes (name, status, lead).
  onChanged: () => void;
}

interface WorkBlockSpec {
  key: string;
  label: string;
  // Browse list slug; direct blocks get "?project=" appended.
  slug: string;
  // Template opened by "+ New" (direct blocks only).
  template?: string;
  direct: boolean;
}

// Report work keys in display order (mirrors labcore/projects.py).
export const WORK_BLOCKS: WorkBlockSpec[] = [
  { key: "wafer", label: "Wafers", slug: "wafers", template: "Wafer", direct: true },
  { key: "device", label: "Devices", slug: "devices", template: "Device", direct: true },
  {
    key: "experiment_setup",
    label: "Experiment setups",
    slug: "experiment-setups",
    template: "Experiment Setup",
    direct: true,
  },
  {
    key: "experiment",
    label: "Experiments",
    slug: "experiments",
    template: "Experiment",
    direct: true,
  },
  {
    key: "analysis_run",
    label: "Analyses",
    slug: "analyses",
    template: "Analysis",
    direct: true,
  },
  // Summaries have no project_id; the report finds them through the
  // project's analyses, so "See all" is the plain list.
  {
    key: "result_summary",
    label: "Result summaries",
    slug: "result-summaries",
    template: "Result Summary",
    direct: false,
  },
  { key: "fab_step", label: "Fab steps", slug: "fab-steps", direct: false },
  { key: "fab_note", label: "Fab notes", slug: "fab-notes", direct: false },
  {
    key: "measurement_run",
    label: "Wafer measurements",
    slug: "wafer-measurements",
    direct: false,
  },
  { key: "design", label: "Designs", slug: "designs", template: "Design", direct: true },
  {
    key: "fab_recipe",
    label: "Fab recipes",
    slug: "fab-recipes",
    template: "Fab Recipe",
    direct: true,
  },
  {
    key: "substrate_batch",
    label: "Substrate batches",
    slug: "substrate-batches",
    template: "Substrate Batch",
    direct: true,
  },
  {
    key: "software",
    label: "Analysis software",
    slug: "analysis-software",
    template: "Analysis Software",
    direct: true,
  },
];

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
};

export function statusLabel(status: unknown): string {
  return typeof status === "string" && STATUS_LABELS[status]
    ? STATUS_LABELS[status]
    : "Active";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isOverdue(item: ProjectItem): boolean {
  return (
    item.kind === "milestone" &&
    item.done_at === null &&
    item.target_date !== null &&
    item.target_date < todayIso()
  );
}

function formatDate(value: string | null): string {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function newRecordLink(template: string, projectId: string): string {
  return `/new?template=${encodeURIComponent(template)}&project=${encodeURIComponent(projectId)}`;
}

/* One line per event, readable without the full feed's entity hydration:
   item events carry their title, membership events their accession, and
   record events resolve through the report's recent lists when possible. */
export function describeProjectEvent(
  event: EventRecord,
  report: ProjectReport,
): string {
  const payload = event.payload;
  const title = typeof payload.title === "string" ? payload.title : "";
  const kind = typeof payload.kind === "string" ? payload.kind : "item";
  switch (event.action) {
    case "project_item.created":
      return `Added ${kind}: ${title}`;
    case "project_item.updated":
      return `Edited ${kind}`;
    case "project_item.done":
      return `Completed ${kind}: ${title}`;
    case "project_item.reopened":
      return `Reopened ${kind}: ${title}`;
    case "project_item.deleted":
      return `Removed ${kind}: ${title}`;
    case "project_item.reordered":
      return `Reordered ${kind}s`;
    case "project.member_added":
      return `Added ${String(payload.accession ?? "a record")} to the project`;
    case "project.member_removed":
      return `Removed ${String(payload.accession ?? "a record")} from the project`;
    default: {
      if (event.entity_id === report.project.id) {
        return `Project ${event.action}`;
      }
      for (const block of Object.values(report.work)) {
        const match = block.recent.find((record) => record.id === event.entity_id);
        if (match) {
          return `${match.name || match.accession} ${event.action}`;
        }
      }
      return `Record ${event.action}`;
    }
  }
}

interface ItemListProps {
  projectId: string;
  kind: ProjectItemKind;
  items: ProjectItem[];
  disabled: boolean;
  onError: (message: string | null) => void;
  onChanged: () => Promise<void>;
}

function ItemList({
  projectId,
  kind,
  items,
  disabled,
  onError,
  onChanged,
}: ItemListProps): ReactElement {
  const [newTitle, setNewTitle] = useState("");
  const [newDate, setNewDate] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const noun = kind === "goal" ? "goal" : "milestone";

  async function run(action: () => Promise<unknown>): Promise<void> {
    setIsBusy(true);
    onError(null);
    try {
      await action();
      await onChanged();
    } catch (error: unknown) {
      onError(
        error instanceof Error ? error.message : `The ${noun} could not be saved.`,
      );
    } finally {
      setIsBusy(false);
    }
  }

  function add(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) {
      return;
    }
    void run(async () => {
      await createProjectItem(projectId, {
        kind,
        title,
        ...(kind === "milestone" && newDate ? { target_date: newDate } : {}),
      });
      setNewTitle("");
      setNewDate("");
    });
  }

  function move(index: number, step: number): void {
    const target = index + step;
    if (target < 0 || target >= items.length) {
      return;
    }
    const order = items.map((item) => item.id);
    [order[index], order[target]] = [order[target], order[index]];
    void run(() => reorderProjectItems(projectId, kind, order));
  }

  function commitTitle(item: ProjectItem): void {
    const title = editTitle.trim();
    setEditingId(null);
    if (!title || title === item.title) {
      return;
    }
    void run(() => patchProjectItem(projectId, item.id, { title }));
  }

  const locked = disabled || isBusy;
  return (
    <div className="project-items">
      {items.length === 0 ? (
        <p className="empty-state">No {noun}s yet.</p>
      ) : (
        <ol className="project-item-list">
          {items.map((item, index) => {
            const done = item.done_at !== null;
            const overdue = isOverdue(item);
            return (
              <li
                className={`project-item${done ? " project-item--done" : ""}`}
                key={item.id}
              >
                <label className="project-item-check">
                  <input
                    aria-label={`${done ? "Reopen" : "Complete"} ${item.title}`}
                    checked={done}
                    disabled={locked}
                    onChange={(event) =>
                      void run(() =>
                        setProjectItemDone(projectId, item.id, event.target.checked),
                      )
                    }
                    type="checkbox"
                  />
                </label>
                <div className="project-item-body">
                  {editingId === item.id ? (
                    <input
                      aria-label={`Edit ${item.title}`}
                      autoFocus
                      className="project-item-title-input"
                      disabled={locked}
                      onBlur={() => commitTitle(item)}
                      onChange={(event) => setEditTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitTitle(item);
                        } else if (event.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      type="text"
                      value={editTitle}
                    />
                  ) : (
                    <button
                      className="project-item-title"
                      disabled={locked}
                      onClick={() => {
                        setEditingId(item.id);
                        setEditTitle(item.title);
                      }}
                      title="Edit title"
                      type="button"
                    >
                      {item.title}
                    </button>
                  )}
                  <div className="project-item-meta">
                    {kind === "milestone" ? (
                      <input
                        aria-label={`Target date for ${item.title}`}
                        disabled={locked}
                        onChange={(event) =>
                          void run(() =>
                            patchProjectItem(projectId, item.id, {
                              target_date: event.target.value || null,
                            }),
                          )
                        }
                        type="date"
                        value={item.target_date ?? ""}
                      />
                    ) : null}
                    {overdue ? <span className="pill pill--overdue">Overdue</span> : null}
                    {done ? (
                      <span className="project-item-done-at">
                        Done {formatDate(item.done_at)}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="project-item-actions">
                  <button
                    aria-label={`Move ${item.title} up`}
                    className="text-button"
                    disabled={locked || index === 0}
                    onClick={() => move(index, -1)}
                    type="button"
                  >
                    ↑
                  </button>
                  <button
                    aria-label={`Move ${item.title} down`}
                    className="text-button"
                    disabled={locked || index === items.length - 1}
                    onClick={() => move(index, 1)}
                    type="button"
                  >
                    ↓
                  </button>
                  {pendingDelete === item.id ? (
                    <button
                      className="text-button text-button--danger"
                      disabled={locked}
                      onClick={() => {
                        setPendingDelete(null);
                        void run(() => deleteProjectItem(projectId, item.id));
                      }}
                      type="button"
                    >
                      Confirm delete
                    </button>
                  ) : (
                    <button
                      aria-label={`Delete ${item.title}`}
                      className="text-button"
                      disabled={locked}
                      onClick={() => setPendingDelete(item.id)}
                      type="button"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <form className="project-item-add" onSubmit={add}>
        <input
          aria-label={`New ${noun}`}
          disabled={locked}
          onChange={(event) => setNewTitle(event.target.value)}
          placeholder={kind === "goal" ? "Add a goal…" : "Add a milestone…"}
          type="text"
          value={newTitle}
        />
        {kind === "milestone" ? (
          <input
            aria-label="New milestone target date"
            disabled={locked}
            onChange={(event) => setNewDate(event.target.value)}
            type="date"
            value={newDate}
          />
        ) : null}
        <button
          className="secondary-button"
          disabled={locked || !newTitle.trim()}
          type="submit"
        >
          Add
        </button>
      </form>
    </div>
  );
}

export function ProjectPage({
  entity,
  etag,
  onChanged,
}: ProjectPageProps): ReactElement {
  const [report, setReport] = useState<ProjectReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [showAddWork, setShowAddWork] = useState(false);

  async function loadReport(): Promise<void> {
    try {
      setReport(await getProjectReport(entity.id));
      setLoadError(null);
    } catch (error: unknown) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "The project report could not be loaded.",
      );
    }
  }

  useEffect(() => {
    let cancelled = false;
    getProjectReport(entity.id)
      .then((loaded) => {
        if (!cancelled) {
          setReport(loaded);
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "The project report could not be loaded.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [entity.id, entity.version]);

  const progress = report?.progress;
  const milestoneTotal = progress?.milestones_total ?? 0;
  const milestoneDone = progress?.milestones_done ?? 0;
  const percent = milestoneTotal > 0 ? Math.round((100 * milestoneDone) / milestoneTotal) : 0;
  const status = String(entity.status ?? "active");
  const workBlocks = report
    ? WORK_BLOCKS.filter((block) => (report.work[block.key]?.count ?? 0) > 0)
    : [];

  return (
    <article className="page-panel entity-page project-page">
      <header className="entity-header">
        <div className="entity-header-controls">
          <div>
            <div className="entity-identity">
              <span>{entity.accession}</span>
              <span>project</span>
              <span className={`pill pill--status-${status}`}>
                {statusLabel(status)}
              </span>
            </div>
          </div>
          <div className="entity-header-actions">
            <button
              className="secondary-button"
              onClick={() => setIsEditing((editing) => !editing)}
              type="button"
            >
              {isEditing ? "Close editor" : "Edit"}
            </button>
            <button
              aria-expanded={showAddWork}
              className="secondary-button"
              onClick={() => setShowAddWork((open) => !open)}
              type="button"
            >
              Add work
            </button>
          </div>
        </div>
        <h1>{entity.name || entity.accession}</h1>
        <p className="lede">{entity.description || "No description provided."}</p>
        {report?.lead ? (
          <p className="project-lead">
            Lead:{" "}
            <Link to={entityRoute(report.lead.id)}>
              {report.lead.name || report.lead.accession}
            </Link>
          </p>
        ) : null}
        {report ? (
          <div className="project-progress">
            <span>
              {milestoneTotal === 0
                ? "No milestones yet"
                : `${milestoneDone} of ${milestoneTotal} milestones done`}
              {progress && progress.overdue_milestones > 0
                ? ` · ${progress.overdue_milestones} overdue`
                : ""}
            </span>
            <div
              aria-label="Milestone progress"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={percent}
              className="project-progress-bar"
              role="progressbar"
            >
              <div className="project-progress-fill" style={{ width: `${percent}%` }} />
            </div>
          </div>
        ) : null}
        {showAddWork ? (
          <nav aria-label="Add work to this project" className="project-add-work">
            {WORK_BLOCKS.filter((block) => block.template).map((block) => (
              <Link key={block.key} to={newRecordLink(block.template as string, entity.id)}>
                + {block.template}
              </Link>
            ))}
          </nav>
        ) : null}
      </header>

      {isEditing ? (
        <EntityEditor
          entity={entity}
          etag={etag}
          onCancel={() => setIsEditing(false)}
          onSaved={() => {
            setIsEditing(false);
            onChanged();
          }}
        />
      ) : null}

      {loadError ? (
        <p className="entity-activity-status entity-activity-status--error">
          {loadError}
        </p>
      ) : null}
      {!report && !loadError ? (
        <p className="entity-activity-status">Loading project report…</p>
      ) : null}
      {itemError ? (
        <p className="entity-activity-status entity-activity-status--error">
          {itemError}
        </p>
      ) : null}

      {report ? (
        <>
          <section className="entity-section" aria-labelledby="goals-heading">
            <p className="eyebrow">Outcomes</p>
            <h2 id="goals-heading">Goals</h2>
            <ItemList
              disabled={isEditing}
              items={report.goals}
              kind="goal"
              onChanged={loadReport}
              onError={setItemError}
              projectId={entity.id}
            />
          </section>

          <section className="entity-section" aria-labelledby="milestones-heading">
            <p className="eyebrow">Schedule</p>
            <h2 id="milestones-heading">Milestones</h2>
            <ItemList
              disabled={isEditing}
              items={report.milestones}
              kind="milestone"
              onChanged={loadReport}
              onError={setItemError}
              projectId={entity.id}
            />
          </section>

          <section className="entity-section" aria-labelledby="work-heading">
            <p className="eyebrow">Work</p>
            <h2 id="work-heading">Work in this project</h2>
            {workBlocks.length === 0 ? (
              <p className="empty-state">
                No work in this project yet.{" "}
                <Link to={newRecordLink("Wafer", entity.id)}>Add a record</Link>.
              </p>
            ) : null}
            <div className="project-work-grid">
              {workBlocks.map((block) => {
                const data = report.work[block.key];
                const seeAll = block.direct
                  ? `/browse/${block.slug}?project=${encodeURIComponent(entity.id)}`
                  : `/browse/${block.slug}`;
                return (
                  <section
                    aria-labelledby={`work-${block.key}`}
                    className="project-work-block"
                    key={block.key}
                  >
                    <div className="section-heading">
                      <h3 id={`work-${block.key}`}>
                        {block.label} <span>({data.count})</span>
                      </h3>
                      <div className="project-work-actions">
                        {block.template ? (
                          <Link to={newRecordLink(block.template, entity.id)}>+ New</Link>
                        ) : null}
                        <Link to={seeAll}>See all</Link>
                      </div>
                    </div>
                    <ul className="project-work-list">
                      {data.recent.map((record) => (
                        <li key={record.id}>
                          <Link to={entityRoute(record.id)}>
                            <span className="project-work-name">
                              {record.name || record.accession}
                            </span>
                            <small>
                              {record.accession} ·{" "}
                              {new Date(record.created_at).toLocaleDateString()}
                            </small>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          </section>

          <section className="entity-section" aria-labelledby="activity-heading">
            <p className="eyebrow">History</p>
            <h2 id="activity-heading">Recent activity</h2>
            {report.events.length === 0 ? (
              <p className="empty-state">No activity yet.</p>
            ) : (
              <ul className="project-activity">
                {report.events.map((event) => (
                  <li key={event.id}>
                    <span className="project-activity-time">
                      {formatDateTime(event.at)}
                    </span>
                    <span>{describeProjectEvent(event, report)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </article>
  );
}
