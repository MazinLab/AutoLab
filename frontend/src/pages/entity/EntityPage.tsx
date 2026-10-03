import { type ReactElement, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  ApiError,
  createEdge,
  deleteEdge,
  deleteEntity,
  getEntity,
  getEntityEvents,
  getEntityLabel,
  getFabFlow,
  getLineageGraph,
  getRegistry,
  getWhoami,
  getTemplates,
  parseAccessionUrl,
  resolveAccession,
  uploadArtifact,
  type EdgeRelation,
  type Entity,
  type EntityTemplate,
  type EventRecord,
  type FabFlowStep,
  type LineageEdge,
  type LineageGraph,
  type LineageNode,
} from "../../api/client";
import { LineageGraph as LineageGraphView } from "../../components/LineageGraph";
import { Markdown } from "../../components/Markdown";
import { PrintLabel } from "../../components/PrintLabel";
import { SubscriptionManager } from "../../components/SubscriptionManager";
import { ProjectPage } from "../project/ProjectPage";
import { ResultSummaryPage } from "../results/ResultSummaryPage";
import { AnalysisResults } from "./AnalysisResults";
import { SetupDesigner } from "../setup/SetupDesigner";
import { EntityEditor } from "./EntityEditor";
import { entityRoute } from "./entityRoute";
import "./entity.css";

/* "Project: <name>" for any record with a project_id; the name comes from
   one fetch per page load. */
function ProjectLink({ projectId }: { projectId: string }): ReactElement {
  const [project, setProject] = useState<Entity | null>(null);
  useEffect(() => {
    let cancelled = false;
    getEntity("project", projectId)
      .then((response) => {
        if (!cancelled) {
          setProject(response.data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProject(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return (
    <p className="entity-project-link">
      Project:{" "}
      <Link to={entityRoute(projectId)}>
        {project ? project.name || project.accession : "…"}
      </Link>
    </p>
  );
}

/* Experiment setups name their testbed; the category makes the split
   visible on setups created before testbeds existed. */
function SetupInstrumentLine({
  instrumentId,
}: {
  instrumentId: string;
}): ReactElement | null {
  const [instrument, setInstrument] = useState<Entity | null>(null);
  useEffect(() => {
    let cancelled = false;
    getEntity("instrument", instrumentId)
      .then((response) => {
        if (!cancelled) {
          setInstrument(response.data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInstrument(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [instrumentId]);
  if (!instrument) {
    return null;
  }
  const category = String(instrument.category ?? "");
  const label =
    category === "testbed"
      ? "Testbed"
      : category === "experimental"
        ? "Experimental equipment"
        : "Instrument";
  return (
    <p className="entity-project-link">
      {label}:{" "}
      <Link to={entityRoute(instrument.id)}>
        {instrument.name || instrument.accession}
      </Link>
    </p>
  );
}

interface EntityPageData {
  entity: Entity;
  etag: string | null;
  label: string;
  graph: LineageGraph;
  events: EventRecord[];
  artifacts: Entity[];
  notes: Entity[];
  // Wafers only: the ordered process history, resolved server-side.
  fabFlow: FabFlowStep[];
  // Hydrated lineage nodes: name/accession/type is all the linked-record
  // list renders, so no per-node getEntity fetch is needed.
  linked: LineageNode[];
  // Depth-1 edges touching this entity, so every related record can offer
  // an exact unlink of the edge that connects it.
  relatedEdges: LineageEdge[];
  templates: EntityTemplate[];
}

function edgeKey(edge: LineageEdge): string {
  return `${edge.src_id}:${edge.relation}:${edge.dst_id}`;
}

export function combineLineageGraphs(
  entity: Entity,
  upstream: LineageGraph,
  downstream: LineageGraph,
): LineageGraph {
  const root: LineageNode = {
    id: entity.id,
    entity_type: entity.entity_type,
    accession: entity.accession,
    depth: 0,
    name: entity.name,
  };
  const nodes = new Map<string, LineageNode>([[root.id, root]]);

  const addNode = (node: LineageNode, depth: number) => {
    if (node.id === root.id) {
      nodes.set(root.id, root);
      return;
    }
    const current = nodes.get(node.id);
    if (!current || Math.abs(depth) < Math.abs(current.depth)) {
      nodes.set(node.id, { ...node, depth });
    }
  };
  upstream.nodes.forEach((node) => addNode(node, -Math.abs(node.depth)));
  downstream.nodes.forEach((node) => addNode(node, Math.abs(node.depth)));

  const edges = new Map<string, LineageEdge>();
  [...upstream.edges, ...downstream.edges].forEach((edge) =>
    edges.set(edgeKey(edge), edge),
  );
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

async function loadEntityHistory(entityId: string): Promise<EventRecord[]> {
  const events: EventRecord[] = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;

  do {
    const page = await getEntityEvents(entityId, { after, limit: 100 });
    events.push(...page.events);
    if (!page.next_cursor || seenCursors.has(page.next_cursor)) {
      break;
    }
    seenCursors.add(page.next_cursor);
    after = page.next_cursor;
  } while (after);

  return events.sort((left, right) => right.at.localeCompare(left.at));
}

function relatedLineageNodes(
  entityId: string,
  graphs: LineageGraph[],
): LineageNode[] {
  const nodes = new Map<string, LineageNode>();
  graphs.forEach((graph) => {
    graph.nodes.forEach((node) => {
      if (node.id === entityId) {
        return;
      }
      const current = nodes.get(node.id);
      // Prefer a hydrated copy when a node appears in several graphs.
      if (!current || (node.name !== undefined && current.name === undefined)) {
        nodes.set(node.id, node);
      }
    });
  });
  return [...nodes.values()];
}

// Artifact and note cards render rich fields (body markdown, media type,
// file size), so they still need the full record. Everything else only shows
// name/accession/type, which the hydrated lineage nodes already carry.
async function loadRelatedEntities(nodes: LineageNode[]): Promise<{
  artifacts: Entity[];
  notes: Entity[];
  linked: LineageNode[];
}> {
  const detailed = await Promise.all(
    nodes
      .filter(
        (node) =>
          node.entity_type === "artifact" || node.entity_type === "note",
      )
      .map((node) =>
        getEntity(node.entity_type, node.id).then((response) => response.data),
      ),
  );
  return {
    artifacts: detailed.filter((entity) => entity.entity_type === "artifact"),
    notes: detailed.filter((entity) => entity.entity_type === "note"),
    linked: nodes.filter(
      (node) => node.entity_type !== "artifact" && node.entity_type !== "note",
    ),
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/* The wafer's process history, in step order: what was run, from which
   recipe, on which machine. The step's own accession stays present but
   quiet — it is the QR identity, not what anyone reads the flow for. */
export function FabFlowList({ steps }: { steps: FabFlowStep[] }) {
  if (steps.length === 0) {
    return null;
  }
  return (
    <ol aria-labelledby="fab-flow-heading" className="fab-flow">
      {steps.map((step) => {
        const title = step.recipe?.name || step.name || "Untitled step";
        const meta = [
          step.instrument?.name,
          new Date(step.created_at).toLocaleDateString(),
        ].filter(Boolean);
        return (
          <li key={step.id}>
            <span aria-hidden="true" className="fab-flow-index">
              {step.step_index}
            </span>
            <div className="fab-flow-detail">
              <Link
                className="fab-flow-title"
                to={`/entity/${encodeURIComponent(step.id)}`}
              >
                <span className="visually-hidden">
                  {`Step ${step.step_index}: `}
                </span>
                {title}
              </Link>
              {meta.length > 0 ? (
                <p className="fab-flow-meta">{meta.join(" · ")}</p>
              ) : null}
              {step.body ? <p className="fab-flow-note">{step.body}</p> : null}
              <p className="fab-flow-refs">
                {step.recipe ? (
                  <Link to={`/entity/${encodeURIComponent(step.recipe.id)}`}>
                    Recipe
                  </Link>
                ) : null}
                <span className="fab-flow-accession">{step.accession}</span>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// Registry bookkeeping and content shown elsewhere on the page; everything
// else that is a scalar belongs in the Details section.
const HIDDEN_DETAIL_FIELDS = new Set([
  "id",
  "accession",
  "entity_type",
  "name",
  "description",
  "extra",
  "source_key",
  "created_by_id",
  "created_at",
  "updated_at",
  "version",
  "body",
  "template",
]);

function formatDetailValue(value: string | number | boolean): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleString();
    }
  }
  return String(value);
}

export function detailEntries(entity: Entity): [string, string][] {
  const entries: [string, string][] = [];
  const push = (key: string, value: unknown) => {
    if (
      (typeof value === "string" && value !== "") ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      entries.push([key, formatDetailValue(value)]);
    }
  };
  for (const [key, value] of Object.entries(entity)) {
    if (HIDDEN_DETAIL_FIELDS.has(key) || key.endsWith("_id")) {
      continue;
    }
    push(key, value);
  }
  for (const [key, value] of Object.entries(entity.extra)) {
    push(key, value);
  }
  return entries;
}

function formatBytes(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = units[0];
  for (const nextUnit of units.slice(1)) {
    if (size < 1024) {
      break;
    }
    size /= 1024;
    unit = nextUnit;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`;
}

export function artifactDownloadUrl(artifact: Entity): string {
  return `/api/artifacts/${encodeURIComponent(artifact.id)}/download`;
}

export function ArtifactCard({
  artifact,
  onZoom,
}: {
  artifact: Entity;
  onZoom?: (artifact: Entity) => void;
}) {
  const downloadUrl = artifactDownloadUrl(artifact);
  const mediaType = stringField(artifact.media_type);
  const dataFormat = stringField(artifact.data_format);
  const size = formatBytes(artifact.size_bytes);
  const displayName = artifact.name || artifact.accession;
  const meta = [mediaType || dataFormat || "File", size]
    .filter(Boolean)
    .join(" · ");

  if (mediaType.startsWith("image/")) {
    // Plots are the payload: show them full size inline, no click required.
    return (
      <figure className="artifact-figure">
        <button
          aria-label={`View ${displayName} full screen`}
          className="artifact-figure-zoom"
          onClick={() => onZoom?.(artifact)}
          type="button"
        >
          <img alt={displayName} loading="lazy" src={downloadUrl} />
        </button>
        <figcaption className="artifact-figure-caption">
          <div>
            <h3>{displayName}</h3>
            <p>{meta}</p>
          </div>
          <a href={downloadUrl} download>
            Download
          </a>
        </figcaption>
      </figure>
    );
  }

  return (
    <article className="artifact-card">
      <div className="artifact-file-type" aria-hidden="true">
        {(dataFormat || mediaType || "file").slice(0, 8)}
      </div>
      <div>
        <h3>{displayName}</h3>
        <p>{meta}</p>
        <a href={downloadUrl} download>
          Download
        </a>
      </div>
    </article>
  );
}

export function ImageLightbox({
  artifact,
  onClose,
}: {
  artifact: Entity;
  onClose: () => void;
}) {
  const displayName = artifact.name || artifact.accession;

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      aria-label={displayName}
      aria-modal="true"
      className="image-lightbox"
      onClick={onClose}
      role="dialog"
    >
      <button
        aria-label="Close full screen view"
        className="image-lightbox-close"
        onClick={onClose}
        type="button"
      >
        ×
      </button>
      <img alt={displayName} src={artifactDownloadUrl(artifact)} />
      <p className="image-lightbox-caption">{displayName}</p>
    </div>
  );
}

const LINK_RELATIONS: EdgeRelation[] = [
  "derived_from",
  "part_of",
  "supersedes",
  "measured_in",
  "mounted_in",
  "performed_on",
  "produced_by",
  "refers_to",
  "annotates",
];

function relationLabel(relation: string): string {
  return relation.replaceAll("_", " ");
}

/** Two-step inline confirm; native dialogs are unavailable by design. */
export function ConfirmButton({
  className,
  confirmLabel,
  label,
  onConfirm,
}: {
  className?: string;
  confirmLabel: string;
  label: string;
  onConfirm: () => void;
}) {
  const [isArmed, setIsArmed] = useState(false);

  useEffect(() => {
    if (!isArmed) {
      return;
    }
    const timer = window.setTimeout(() => setIsArmed(false), 5000);
    return () => window.clearTimeout(timer);
  }, [isArmed]);

  return (
    <button
      className={`${className ?? "secondary-button"}${isArmed ? " confirm-armed" : ""}`}
      onClick={() => {
        if (isArmed) {
          setIsArmed(false);
          onConfirm();
        } else {
          setIsArmed(true);
        }
      }}
      type="button"
    >
      {isArmed ? confirmLabel : label}
    </button>
  );
}

function describeEdge(entity: Entity, edge: LineageEdge): string {
  return edge.src_id === entity.id
    ? `this record ${relationLabel(edge.relation)} it`
    : `it ${relationLabel(edge.relation)} this record`;
}

function UnlinkControl({
  edge,
  entity,
  onDone,
  onError,
}: {
  edge: LineageEdge;
  entity: Entity;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  return (
    <span className="unlink-control" title={describeEdge(entity, edge)}>
      <span className="unlink-relation">{relationLabel(edge.relation)}</span>
      <ConfirmButton
        className="unlink-button"
        confirmLabel="Confirm unlink"
        label="Unlink"
        onConfirm={() => {
          deleteEdge({
            src_id: edge.src_id,
            relation: edge.relation,
            dst_id: edge.dst_id,
          })
            .then(onDone)
            .catch((error: unknown) =>
              onError(
                error instanceof Error ? error.message : "Unlink failed.",
              ),
            );
        }}
      />
    </span>
  );
}

/** Merge newly picked files, skipping name+size duplicates. */
function mergeFiles(current: File[], added: Iterable<File>): File[] {
  const next = [...current];
  for (const file of added) {
    const isDuplicate = next.some(
      (existing) => existing.name === file.name && existing.size === file.size,
    );
    if (!isDuplicate) {
      next.push(file);
    }
  }
  return next;
}

function attachFileKey(file: File): string {
  return `${file.name}:${file.size}`;
}

function AttachFileControl({
  entity,
  onDone,
  onError,
}: {
  entity: Entity;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  // Per-file upload error, keyed by name:size; failed File objects stay in
  // `files` so a camera shot survives a flaky upload and can be retried.
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});
  const [relation, setRelation] = useState<"annotates" | "refers_to">(
    "annotates",
  );
  const [isUploading, setIsUploading] = useState(false);

  function addFiles(picked: FileList | null): void {
    if (picked && picked.length > 0) {
      // Copy now: Safari empties this FileList in place when the input is
      // cleared, which happens before React runs the updater.
      const files = Array.from(picked);
      setFiles((current) => mergeFiles(current, files));
    }
  }

  function removeFile(index: number): void {
    const removed = files[index];
    setFiles((current) => current.filter((_, i) => i !== index));
    if (removed) {
      setUploadErrors((current) => {
        const next = { ...current };
        delete next[attachFileKey(removed)];
        return next;
      });
    }
  }

  async function uploadAll(): Promise<void> {
    const failed: File[] = [];
    const errors: Record<string, string> = {};
    let uploadedCount = 0;
    for (const file of files) {
      try {
        await uploadArtifact(file, { linkEntityId: entity.id, relation });
        uploadedCount += 1;
      } catch (error: unknown) {
        failed.push(file);
        errors[attachFileKey(file)] =
          error instanceof Error ? error.message : "The upload failed.";
      }
    }
    // Only the files that made it are cleared; failures stay selected with
    // their error so they can be retried without recapturing.
    setFiles(failed);
    setUploadErrors(errors);
    if (failed.length > 0) {
      onError(
        `Upload failed for: ${failed.map((file) => file.name).join(", ")} — ` +
          "the files are still selected below; retry or remove them.",
      );
    } else if (uploadedCount > 0) {
      // A full success refreshes the page data. On partial failure the
      // refresh is deferred (it would remount this control and lose the
      // retained files); the retry that clears the list triggers it.
      onDone();
    }
  }

  return (
    <form
      className="attach-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (files.length === 0 || isUploading) {
          return;
        }
        setIsUploading(true);
        void uploadAll().finally(() => setIsUploading(false));
      }}
    >
      <div className="attach-sources">
        <label className="attachment-browse attach-source">
          Take photo
          <input
            accept="image/*"
            aria-label="Take a photo to attach"
            capture="environment"
            disabled={isUploading}
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = "";
            }}
            type="file"
          />
        </label>
        <label className="attachment-browse attach-source">
          Choose files
          <input
            aria-label="Attach files to this record"
            disabled={isUploading}
            multiple
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = "";
            }}
            type="file"
          />
        </label>
      </div>
      <select
        aria-label="How the file relates to this record"
        disabled={isUploading}
        onChange={(event) =>
          setRelation(event.target.value as "annotates" | "refers_to")
        }
        value={relation}
      >
        <option value="annotates">annotates</option>
        <option value="refers_to">refers to</option>
      </select>
      <button disabled={files.length === 0 || isUploading} type="submit">
        {isUploading
          ? "Uploading…"
          : Object.keys(uploadErrors).length > 0
            ? "Retry failed uploads"
            : files.length > 1
              ? `Attach ${files.length} files`
              : "Attach"}
      </button>
      {files.length > 0 ? (
        <ul className="attach-file-list">
          {files.map((file, index) => (
            <li key={attachFileKey(file)}>
              <span className="attachment-name">{file.name}</span>
              {uploadErrors[attachFileKey(file)] ? (
                <span className="attachment-error">
                  {uploadErrors[attachFileKey(file)]}
                </span>
              ) : null}
              <button
                aria-label={`Remove ${file.name}`}
                className="text-button"
                disabled={isUploading}
                onClick={() => removeFile(index)}
                type="button"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}

function AddLinkControl({
  entity,
  onDone,
  onError,
}: {
  entity: Entity;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [relation, setRelation] = useState<EdgeRelation>("refers_to");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [target, setTarget] = useState("");
  const [isLinking, setIsLinking] = useState(false);

  if (!isOpen) {
    return (
      <button
        className="secondary-button"
        onClick={() => setIsOpen(true)}
        type="button"
      >
        + Add link
      </button>
    );
  }

  return (
    <form
      className="add-link-form"
      onSubmit={(event) => {
        event.preventDefault();
        const accession = parseAccessionUrl(target);
        if (!accession || isLinking) {
          return;
        }
        setIsLinking(true);
        resolveAccession(accession)
          .then((resolved) =>
            createEdge(
              direction === "out"
                ? {
                    src_id: entity.id,
                    relation,
                    dst_id: resolved.data.id,
                  }
                : {
                    src_id: resolved.data.id,
                    relation,
                    dst_id: entity.id,
                  },
            ),
          )
          .then(() => {
            setTarget("");
            setIsOpen(false);
            onDone();
          })
          .catch((error: unknown) =>
            onError(
              error instanceof ApiError && error.status === 404
                ? `No record with accession ${accession}.`
                : error instanceof Error
                  ? error.message
                  : "Linking failed.",
            ),
          )
          .finally(() => setIsLinking(false));
      }}
    >
      <select
        aria-label="Link direction"
        onChange={(event) => setDirection(event.target.value as "out" | "in")}
        value={direction}
      >
        <option value="out">this record →</option>
        <option value="in">→ this record</option>
      </select>
      <select
        aria-label="Relation"
        onChange={(event) => setRelation(event.target.value as EdgeRelation)}
        value={relation}
      >
        {LINK_RELATIONS.map((linkRelation) => (
          <option key={linkRelation} value={linkRelation}>
            {relationLabel(linkRelation)}
          </option>
        ))}
      </select>
      <input
        aria-label="Target accession"
        onChange={(event) => setTarget(event.target.value)}
        placeholder="W-2026-0001 or /e/ link"
        value={target}
      />
      <button disabled={!target.trim() || isLinking} type="submit">
        {isLinking ? "Linking…" : "Link"}
      </button>
      <button
        className="secondary-button"
        onClick={() => setIsOpen(false)}
        type="button"
      >
        Cancel
      </button>
    </form>
  );
}

function NoteCard({ note }: { note: Entity }) {
  const body = stringField(note.body);
  return (
    <article className="note-card">
      <h3>{note.name || note.accession}</h3>
      {body ? (
        <div className="note-body">
          <Markdown source={body} />
        </div>
      ) : (
        <p className="note-body">{note.description || "No note body."}</p>
      )}
    </article>
  );
}

export function EntityPage() {
  const { id } = useParams();
  const [pageData, setPageData] = useState<EntityPageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [isLoadingActivity, setIsLoadingActivity] = useState(false);
  const [isHistoryAvailable, setIsHistoryAvailable] = useState(false);
  const [areRelatedRecordsAvailable, setAreRelatedRecordsAvailable] =
    useState(false);
  const [zoomedArtifact, setZoomedArtifact] = useState<Entity | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  // Identity-gated deployments 403 writes without a resolved login; hide
  // the results editing controls in that case (the header buttons follow
  // the shell's own status).
  const [canWrite, setCanWrite] = useState(true);
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
  const [reloadKey, setReloadKey] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!id) {
      setError("No entity ID was provided.");
      return;
    }
    let isCurrent = true;
    setPageData(null);
    setError(null);
    setActivityError(null);
    setIsLoadingActivity(true);
    setIsHistoryAvailable(false);
    setAreRelatedRecordsAvailable(false);

    const load = async () => {
      const registry = await getRegistry(id);
      const [entityResponse, upstream, downstream, label, templates] =
        await Promise.all([
          getEntity(registry.entity_type, id),
          getLineageGraph(id, { direction: "up", depth: 5, hydrate: true }),
          getLineageGraph(id, { direction: "down", depth: 5, hydrate: true }),
          getEntityLabel(id).catch(() => ""),
          getTemplates().catch(() => [] as EntityTemplate[]),
        ]);
      const entity = entityResponse.data;
      const graph = combineLineageGraphs(entity, upstream, downstream);
      if (isCurrent) {
        setPageData({
          entity,
          etag: entityResponse.etag,
          label,
          graph,
          events: [],
          artifacts: [],
          notes: [],
          fabFlow: [],
          linked: [],
          relatedEdges: [],
          templates,
        });
      }

      const [historyResult, relatedResult, fabFlowResult] =
        await Promise.allSettled([
          loadEntityHistory(id),
          Promise.all([
            getLineageGraph(id, {
              direction: "both",
              depth: 1,
              relations: ["refers_to", "annotates"],
              hydrate: true,
            }),
            getLineageGraph(id, {
              direction: "both",
              depth: 1,
              relations: [
                "derived_from",
                "supersedes",
                "measured_in",
                "mounted_in",
                "performed_on",
                "produced_by",
                "part_of",
              ],
              hydrate: true,
            }),
          ]).then((relatedGraphs) =>
            loadRelatedEntities(relatedLineageNodes(id, relatedGraphs)).then(
              (related) => ({
                ...related,
                relatedEdges: relatedGraphs.flatMap((relatedGraph) =>
                  relatedGraph.edges.filter(
                    (edge) => edge.src_id === id || edge.dst_id === id,
                  ),
                ),
              }),
            ),
          ),
          entity.entity_type === "wafer"
            ? getFabFlow(id)
            : Promise.resolve([] as FabFlowStep[]),
        ]);
      if (isCurrent) {
        const hasHistory = historyResult.status === "fulfilled";
        const hasRelatedRecords = relatedResult.status === "fulfilled";
        setPageData({
          entity,
          etag: entityResponse.etag,
          label,
          graph,
          events: hasHistory ? historyResult.value : [],
          templates,
          // A failed flow fetch degrades to an empty process list; the rest
          // of the page still renders.
          fabFlow:
            fabFlowResult.status === "fulfilled" ? fabFlowResult.value : [],
          ...(hasRelatedRecords
            ? relatedResult.value
            : { artifacts: [], notes: [], linked: [], relatedEdges: [] }),
        });
        setIsHistoryAvailable(hasHistory);
        setAreRelatedRecordsAvailable(hasRelatedRecords);
        setActivityError(
          hasHistory && hasRelatedRecords
            ? null
            : hasHistory
              ? "Related records could not be loaded."
              : hasRelatedRecords
                ? "Event history could not be loaded."
                : "Related records and event history could not be loaded.",
        );
        setIsLoadingActivity(false);
      }
    };

    void load().catch((loadError: unknown) => {
      if (!isCurrent) {
        return;
      }
      setIsLoadingActivity(false);
      setError(
        loadError instanceof ApiError && loadError.status === 404
          ? "Entity not found."
          : loadError instanceof Error
            ? loadError.message
            : "The entity could not be loaded.",
      );
    });

    return () => {
      isCurrent = false;
    };
  }, [id, reloadKey]);

  if (error) {
    return (
      <section className="page-panel">
        <p className="eyebrow">Entity</p>
        <h1>Could not load record</h1>
        <p className="lede">{error}</p>
      </section>
    );
  }

  if (!pageData) {
    return (
      <section className="page-panel">
        <p className="eyebrow">Entity</p>
        <h1>Loading record</h1>
        <p className="lede">Fetching metadata, lineage, and history…</p>
      </section>
    );
  }

  const {
    entity,
    etag,
    label,
    graph,
    events,
    artifacts,
    notes,
    fabFlow,
    linked,
    relatedEdges,
    templates,
  } = pageData;
  // Steps listed in the fab flow would only repeat themselves in Related
  // records, where they read as a bag of accession codes.
  const fabFlowIds = new Set(fabFlow.map((step) => step.id));
  const linkedRecords = linked.filter((record) => !fabFlowIds.has(record.id));
  // Summaries this analysis is a member of (outbound refers_to). They stay in
  // Related records too, where the generic unlink control lives.
  const summaryNodes =
    entity.entity_type === "analysis_run"
      ? linked.filter(
          (record) =>
            record.entity_type === "result_summary" &&
            relatedEdges.some(
              (edge) =>
                edge.src_id === entity.id &&
                edge.dst_id === record.id &&
                edge.relation === "refers_to",
            ),
        )
      : [];
  const ownBody = stringField(entity.body);
  const details = detailEntries(entity);
  // Clone/Supersede route through the templated New-record form, so they only
  // make sense when a template exists for this record: notes match on their
  // template name, everything else on entity type.
  const hasTemplate =
    entity.entity_type === "note"
      ? templates.some(
          (template) => template.name === stringField(entity.template),
        )
      : templates.some(
          (template) => template.entity_type === entity.entity_type,
        );
  const refresh = () => {
    setActionError(null);
    setReloadKey((key) => key + 1);
  };
  const edgesFor = (recordId: string): LineageEdge[] =>
    relatedEdges.filter(
      (edge) => edge.src_id === recordId || edge.dst_id === recordId,
    );
  if (entity.entity_type === "project") {
    return <ProjectPage entity={entity} etag={etag} onChanged={refresh} />;
  }
  const projectId =
    typeof entity.project_id === "string" && entity.project_id
      ? entity.project_id
      : null;
  const setupInstrumentId =
    entity.entity_type === "experiment_setup"
      ? (relatedEdges.find(
          (edge) =>
            edge.src_id === entity.id && edge.relation === "performed_on",
        )?.dst_id ?? null)
      : null;
  return (
    <article
      className={
        entity.entity_type === "experiment_setup" ||
        entity.entity_type === "result_summary"
          ? "page-panel entity-page entity-page--wide"
          : "page-panel entity-page"
      }
    >
      <header className="entity-header">
        <div className="entity-header-controls">
          <div>
            <div className="entity-identity">
              <span>{entity.accession}</span>
              <span>{entity.entity_type.replaceAll("_", " ")}</span>
            </div>
            <p
              className="entity-derived-label"
              title="derived from provenance; not an identifier"
            >
              {label}
            </p>
          </div>
          <div className="entity-header-actions">
            <button
              className="secondary-button"
              onClick={() => setIsEditing((editing) => !editing)}
              type="button"
            >
              {isEditing ? "Close editor" : "Edit"}
            </button>
            {hasTemplate ? (
              <>
                <Link
                  className="entity-action-link"
                  to={`/new?from=${encodeURIComponent(entity.id)}`}
                >
                  Clone
                </Link>
                <Link
                  className="entity-action-link"
                  to={`/new?supersede=${encodeURIComponent(entity.id)}`}
                >
                  Supersede
                </Link>
              </>
            ) : null}
            <PrintLabel entityId={entity.id} />
          </div>
        </div>
        <h1>{entity.name || entity.accession}</h1>
        <p className="lede">
          {entity.description || "No description provided."}
        </p>
        {projectId ? <ProjectLink projectId={projectId} /> : null}
        {setupInstrumentId ? (
          <SetupInstrumentLine instrumentId={setupInstrumentId} />
        ) : null}
      </header>

      {isEditing ? (
        <EntityEditor
          entity={entity}
          etag={etag}
          onCancel={() => setIsEditing(false)}
          onSaved={() => {
            setIsEditing(false);
            setReloadKey((key) => key + 1);
          }}
        />
      ) : null}

      {!isEditing && entity.entity_type === "experiment_setup" ? (
        <section className="entity-section" aria-labelledby="setup-heading">
          <p className="eyebrow">Loadout</p>
          <h2 id="setup-heading">Setup</h2>
          <SetupDesigner
            key={`${entity.id}-${entity.version}`}
            onSaved={refresh}
            setup={entity}
            testbedId={setupInstrumentId}
          />
        </section>
      ) : null}

      {!isEditing && entity.entity_type === "result_summary" ? (
        <section className="entity-section" aria-labelledby="results-heading">
          <p className="eyebrow">Meta-analysis</p>
          <h2 id="results-heading">Analyses</h2>
          <ResultSummaryPage
            etag={etag}
            key={`${entity.id}-${entity.version}`}
            onChanged={refresh}
            summary={entity}
          />
        </section>
      ) : null}

      {!isEditing && entity.entity_type === "analysis_run" ? (
        <AnalysisResults
          analysis={entity}
          canWrite={canWrite}
          etag={etag}
          key={`${entity.id}-${entity.version}`}
          onChanged={refresh}
          summaries={summaryNodes}
        />
      ) : null}

      {!isEditing && ownBody ? (
        <section className="entity-section" aria-labelledby="body-heading">
          <p className="eyebrow">
            {stringField(entity.template) || "Notebook"}
          </p>
          <h2 id="body-heading">Log</h2>
          <div className="entity-note-body">
            <Markdown source={ownBody} />
          </div>
        </section>
      ) : null}

      {!isEditing && entity.entity_type === "person" ? (
        <SubscriptionManager personId={entity.id} />
      ) : null}

      {actionError ? (
        <p className="entity-activity-status entity-activity-status--error">
          {actionError}
        </p>
      ) : null}

      {isLoadingActivity ? (
        <p className="entity-activity-status">
          Loading related records and event history…
        </p>
      ) : null}
      {activityError ? (
        <p className="entity-activity-status entity-activity-status--error">
          {activityError}
        </p>
      ) : null}

      {entity.entity_type === "wafer" ? (
        <section className="entity-section" aria-labelledby="fab-flow-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Process</p>
              <h2 id="fab-flow-heading">Fab flow</h2>
            </div>
            <Link
              className="secondary-button"
              to={`/new?template=Fab+Step&for=${encodeURIComponent(entity.id)}`}
            >
              + Add step
            </Link>
          </div>
          <FabFlowList steps={fabFlow} />
          {areRelatedRecordsAvailable && fabFlow.length === 0 ? (
            <p className="empty-state">
              No fab steps recorded yet — add one to start the flow.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* A note's own body is its log; listing notes attached to a note
          only duplicated that section, so notes hide the Notebook list. */}
      {entity.entity_type !== "note" ? (
        <section className="entity-section" aria-labelledby="notes-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Notebook</p>
              <h2 id="notes-heading">Notes</h2>
            </div>
            <Link
              className="secondary-button"
              to={`/notes/new?mention=${encodeURIComponent(entity.accession)}`}
            >
              + New note
            </Link>
          </div>
          <div className="related-list">
            {notes.map((note) => (
              <div className="related-item" key={note.id}>
                <NoteCard note={note} />
                <span className="linked-record-actions">
                  {edgesFor(note.id).map((edge) => (
                    <UnlinkControl
                      edge={edge}
                      entity={entity}
                      key={edgeKey(edge)}
                      onDone={refresh}
                      onError={setActionError}
                    />
                  ))}
                </span>
              </div>
            ))}
            {areRelatedRecordsAvailable && notes.length === 0 ? (
              <p className="empty-state">No related notes are recorded.</p>
            ) : null}
          </div>
        </section>
      ) : null}

      {!isEditing && details.length > 0 ? (
        <section className="entity-section" aria-labelledby="details-heading">
          <p className="eyebrow">Record</p>
          <h2 id="details-heading">Details</h2>
          <dl className="entity-details">
            {details.map(([key, value]) => (
              <div key={key}>
                <dt>{key.replaceAll("_", " ")}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section className="entity-section" aria-labelledby="artifacts-heading">
        <p className="eyebrow">Files</p>
        <h2 id="artifacts-heading">Artifacts</h2>
        <AttachFileControl
          entity={entity}
          onDone={refresh}
          onError={setActionError}
        />
        <div className="related-list">
          {artifacts.map((artifact) => (
            <div className="related-item" key={artifact.id}>
              <ArtifactCard artifact={artifact} onZoom={setZoomedArtifact} />
              <span className="linked-record-actions">
                {edgesFor(artifact.id).map((edge) => (
                  <UnlinkControl
                    edge={edge}
                    entity={entity}
                    key={edgeKey(edge)}
                    onDone={refresh}
                    onError={setActionError}
                  />
                ))}
              </span>
            </div>
          ))}
          {areRelatedRecordsAvailable && artifacts.length === 0 ? (
            <p className="empty-state">No related artifacts are recorded.</p>
          ) : null}
        </div>
      </section>

      <section className="entity-section" aria-labelledby="linked-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Connections</p>
            <h2 id="linked-heading">Related records</h2>
          </div>
          <AddLinkControl
            entity={entity}
            onDone={refresh}
            onError={setActionError}
          />
        </div>
        {linkedRecords.length > 0 ? (
          <ul aria-labelledby="linked-heading" className="linked-records">
            {linkedRecords.map((record) => (
              <li key={record.id}>
                <Link to={`/entity/${encodeURIComponent(record.id)}`}>
                  {/* Name leads; the accession is identity, not a headline,
                      and only stands in when a record has no name. */}
                  <strong>{record.name || record.accession}</strong>
                  <small>
                    {record.entity_type.replaceAll("_", " ")}
                    {record.name ? ` · ${record.accession}` : ""}
                  </small>
                </Link>
                <span className="linked-record-actions">
                  {edgesFor(record.id).map((edge) => (
                    <UnlinkControl
                      edge={edge}
                      entity={entity}
                      key={edgeKey(edge)}
                      onDone={refresh}
                      onError={setActionError}
                    />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">
            No related records yet — link one by accession.
          </p>
        )}
      </section>

      <section className="entity-section" aria-labelledby="lineage-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Provenance</p>
            <h2 id="lineage-heading">Lineage</h2>
          </div>
          <span>Upstream ← depth → downstream</span>
        </div>
        <LineageGraphView focusId={entity.id} graph={graph} />
      </section>

      <section className="entity-section" aria-labelledby="events-heading">
        <p className="eyebrow">History</p>
        <h2 id="events-heading">Events</h2>
        <ol className="event-feed">
          {events.map((event) => (
            <li key={event.id}>
              <div>
                <strong>{event.action}</strong>
                <time dateTime={event.at}>
                  {new Date(event.at).toLocaleString()}
                </time>
              </div>
              {Object.keys(event.payload).length > 0 ? (
                <code>{JSON.stringify(event.payload)}</code>
              ) : null}
            </li>
          ))}
        </ol>
        {isHistoryAvailable && events.length === 0 ? (
          <p className="empty-state">No events are visible for this entity.</p>
        ) : null}
      </section>

      <section
        className="entity-section danger-zone"
        aria-labelledby="danger-heading"
      >
        <p className="eyebrow">Corrections</p>
        <h2 id="danger-heading">Danger zone</h2>
        <p className="danger-zone-hint">
          Deleting permanently removes this record and every link to it; the
          event feed keeps a tombstone. Prefer superseding or editing — delete
          only mistakes.
        </p>
        <ConfirmButton
          className="danger-button"
          confirmLabel="Permanently delete this record"
          label="Delete this record"
          onConfirm={() => {
            deleteEntity(entity.entity_type, entity.id)
              .then(() => navigate("/"))
              .catch((deleteError: unknown) =>
                setActionError(
                  deleteError instanceof Error
                    ? deleteError.message
                    : "Delete failed.",
                ),
              );
          }}
        />
      </section>

      {zoomedArtifact ? (
        <ImageLightbox
          artifact={zoomedArtifact}
          onClose={() => setZoomedArtifact(null)}
        />
      ) : null}
    </article>
  );
}
