export const ACTOR_STORAGE_KEY = "autolab.actor";
export const API_BASE_URL = "";

export const ENTITY_TYPES = [
  "project",
  "person",
  "agent",
  "instrument",
  "design",
  "fab_recipe",
  "fab_step",
  "substrate_batch",
  "wafer",
  "device",
  "experiment_setup",
  "measurement_run",
  "analysis_run",
  "software",
  "result_summary",
  "artifact",
  "note",
  "review_task",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export function isEntityType(
  value: string | null | undefined,
): value is EntityType {
  return ENTITY_TYPES.some((entityType) => entityType === value);
}

export interface Entity {
  [key: string]: unknown;
  id: string;
  accession: string;
  entity_type: EntityType;
  name: string;
  description: string;
  extra: Record<string, unknown>;
  source_key: string | null;
  created_by_id: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface EntityRegistry {
  id: string;
  entity_type: EntityType;
  accession: string;
  source_key: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by_id: string | null;
}

export type EntityInput = Record<string, unknown>;
export type EntityPatch = Record<string, unknown>;

export interface EntityResponse<T extends Entity = Entity> {
  data: T;
  etag: string | null;
}

export interface SearchResult {
  id: string;
  entity_type: EntityType;
  accession: string;
  name: string;
  // Context around the first body match, when the hit came from body text.
  snippet?: string | null;
}

export interface LineageNode {
  id: string;
  entity_type: EntityType;
  accession: string;
  depth: number;
  /** Present when the query asked for hydrate=true. */
  name?: string;
}

export interface LineageEdge {
  src_id: string;
  dst_id: string;
  relation: EdgeRelation;
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export type LabelFormat = "qr" | "text";

export interface PrintLabelOptions {
  printer?: string;
  labelFormat?: LabelFormat;
}

export interface PrintLabelResult {
  printer: string;
  format: LabelFormat;
}

export interface CatalogSchema {
  entity_types: Partial<Record<EntityType, Record<string, unknown>>>;
  relations: EdgeRelation[];
}

export type EdgeRelation =
  | "derived_from"
  | "supersedes"
  | "measured_in"
  | "mounted_in"
  | "performed_on"
  | "produced_by"
  | "refers_to"
  | "part_of"
  | "annotates";

export interface CreateEdgeInput {
  src_id: string;
  relation: EdgeRelation;
  dst_id: string;
}

export interface CreatedEdge {
  id: string;
}

export interface EventRecord {
  id: string;
  at: string;
  actor_id: string | null;
  action: string;
  entity_id: string;
  payload: Record<string, unknown>;
}

export interface EventPage {
  events: EventRecord[];
  next_cursor: string | null;
}

export interface FeedEntitySummary {
  id: string;
  entity_type: EntityType;
  accession: string;
  name: string;
}

export interface FeedItem extends EventRecord {
  entity: FeedEntitySummary | null;
  actor: FeedEntitySummary | null;
}

export interface FeedPage {
  items: FeedItem[];
  next_cursor: string | null;
}

export interface FeedQuery {
  before?: string;
  limit?: number;
  actions?: string;
  actor?: string;
  entityType?: EntityType;
  /** ISO datetime lower bound (naive values read as UTC). */
  since?: string;
  /** ISO datetime upper bound (naive values read as UTC). */
  until?: string;
}

export interface Whoami {
  login: string | null;
  person: Entity | null;
  mapped: boolean;
  /** False when identity-gated deployments will 403 this client's writes. */
  can_write?: boolean;
}

export type TemplateFieldType =
  | "text"
  | "number"
  | "datetime"
  | "entity"
  | "select"
  // Repeatable key / value rows submitted as one map (analysis results).
  | "results";

export interface TemplateField {
  name: string;
  label: string;
  type: TemplateFieldType;
  unit?: string;
  required?: boolean;
  // "select" fields: the allowed values, submitted as the string.
  options?: string[];
  default?: string;
}

export interface EntityTemplate {
  name: string;
  entity_type: EntityType;
  // Themed column on the New record page ("fab" | "testing").
  group?: string;
  // Constant field values the template stamps onto every record it creates
  // (e.g. instrument category); never shown as form inputs.
  defaults?: Record<string, unknown>;
  fields: TemplateField[];
  body: boolean;
  // Show the attachment drop zone even without a markdown body (e.g. an
  // equipment photo). Body templates always get attachments.
  attachments?: boolean;
  // Offer the notify-people picker: one-shot DMs about the created record.
  notify?: boolean;
  // Show the Copies control: only physical, countable things (wafers,
  // devices) are ever created as a batch of identical records.
  batch?: boolean;
  // Setup designer: render a "Start from" layout picker after this entity
  // field (the testbed), seeding the record's layout at create.
  start_from?: { field: string };
}

export interface Pagination {
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
  orderBy?: "created" | "updated";
  // Server-side name/description substring match.
  q?: string;
  // Typed column equality filters, e.g. { template: "Experiment" }.
  filters?: Record<string, string>;
  // JSON extra-key equality filters (compared as text).
  extraFilters?: Record<string, string>;
}

export interface EntityPage_<T extends Entity = Entity> {
  rows: T[];
  // Total rows matching the filters (ignoring limit/offset).
  total: number;
}

// One link created atomically with the record via the `links` payload key.
export interface EntityLink {
  relation: EdgeRelation;
  dst_id?: string;
  dst_accession?: string;
}

export interface EventQuery {
  after?: string;
  limit?: number;
}

export interface LineageQuery {
  direction?: "up" | "down" | "both";
  depth?: number;
  relations?: EdgeRelation[];
  /** Ask the server to attach display names to nodes. */
  hydrate?: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown) {
    const message =
      typeof detail === "string" ? detail : `API request failed (${status})`;
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** The globally selected actor (ActorPicker writes it to localStorage). */
export function currentActorId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const storedActor = window.localStorage.getItem(ACTOR_STORAGE_KEY)?.trim();
    return storedActor || null;
  } catch {
    // Blocked or non-functional storage: read as "no actor selected".
    return null;
  }
}

/** Per-request actor: a string sends that X-Actor-Id (overriding the global
 * selection), null sends NO actor header at all, undefined falls back to the
 * globally selected actor. */
export type ActorOverride = string | null | undefined;

function requestHeaders(
  initialHeaders?: HeadersInit,
  actor: ActorOverride = undefined,
): Headers {
  const headers = new Headers(initialHeaders);
  headers.set("Accept", "application/json");

  if (actor === null) {
    headers.delete("X-Actor-Id");
    return headers;
  }
  if (actor !== undefined) {
    headers.set("X-Actor-Id", actor);
    return headers;
  }
  const storedActor = currentActorId();
  if (storedActor && !headers.has("X-Actor-Id")) {
    headers.set("X-Actor-Id", storedActor);
  }
  return headers;
}

interface ApiRequestInit extends RequestInit {
  actor?: ActorOverride;
}

async function apiRequest<T>(
  path: string,
  init: ApiRequestInit = {},
): Promise<{
  data: T;
  response: Response;
}> {
  const { actor, ...requestInit } = init;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...requestInit,
    headers: requestHeaders(requestInit.headers, actor),
  });

  if (!response.ok) {
    let detail: unknown = response.statusText;
    try {
      const payload = (await response.json()) as { detail?: unknown };
      detail = payload.detail ?? detail;
    } catch {
      // Some proxy and server failures do not have a JSON response body.
    }
    throw new ApiError(response.status, detail);
  }

  return {
    data: (await response.json()) as T,
    response,
  };
}

function jsonRequest(body: unknown, headers?: HeadersInit): RequestInit {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Content-Type", "application/json");
  return {
    body: JSON.stringify(body),
    headers: requestHeaders,
  };
}

function withQuery(
  path: string,
  values: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  });
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export interface CreateEntityOptions {
  /** Actor for this request only: a string overrides the globally selected
   * actor, null sends no X-Actor-Id header, undefined keeps the global one.
   * The offline outbox uses this to replay with the actor captured at
   * enqueue time rather than whoever is selected at replay time. */
  actorId?: string | null;
}

export async function createEntity<T extends Entity = Entity>(
  entityType: EntityType,
  input: EntityInput,
  options: CreateEntityOptions = {},
): Promise<T> {
  const result = await apiRequest<T>(`/api/${entityType}`, {
    ...jsonRequest(input),
    method: "POST",
    actor: options.actorId,
  });
  return result.data;
}

function listQueryValues(
  pagination: Pagination,
): Record<string, string | number | undefined> {
  const values: Record<string, string | number | undefined> = {
    limit: pagination.limit,
    offset: pagination.offset,
    order: pagination.order,
    order_by: pagination.orderBy,
    q: pagination.q,
  };
  Object.entries(pagination.filters ?? {}).forEach(([field, value]) => {
    values[`f.${field}`] = value;
  });
  Object.entries(pagination.extraFilters ?? {}).forEach(([key, value]) => {
    values[`x.${key}`] = value;
  });
  return values;
}

export async function listEntities<T extends Entity = Entity>(
  entityType: EntityType,
  pagination: Pagination = {},
): Promise<T[]> {
  const path = withQuery(`/api/${entityType}`, listQueryValues(pagination));
  const result = await apiRequest<T[]>(path);
  return result.data;
}

export async function listEntitiesPage<T extends Entity = Entity>(
  entityType: EntityType,
  pagination: Pagination = {},
): Promise<EntityPage_<T>> {
  const path = withQuery(`/api/${entityType}`, {
    ...listQueryValues(pagination),
    with_count: "true",
  });
  const result = await apiRequest<T[]>(path);
  return {
    rows: result.data,
    total: Number(
      result.response.headers.get("X-Total-Count") ?? result.data.length,
    ),
  };
}

export async function deleteEntity(
  entityType: EntityType,
  entityId: string,
): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL}/api/${entityType}/${encodeURIComponent(entityId)}`,
    { headers: requestHeaders(), method: "DELETE" },
  );
  if (!response.ok) {
    let detail: unknown = response.statusText;
    try {
      detail =
        ((await response.json()) as { detail?: unknown }).detail ?? detail;
    } catch {
      // Non-JSON error body.
    }
    throw new ApiError(response.status, detail);
  }
}

export async function deleteEdge(input: CreateEdgeInput): Promise<void> {
  const path = withQuery("/api/edges", {
    src_id: input.src_id,
    relation: input.relation,
    dst_id: input.dst_id,
  });
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: requestHeaders(),
    method: "DELETE",
  });
  if (!response.ok) {
    let detail: unknown = response.statusText;
    try {
      detail =
        ((await response.json()) as { detail?: unknown }).detail ?? detail;
    } catch {
      // Non-JSON error body.
    }
    throw new ApiError(response.status, detail);
  }
}

export async function getEntity<T extends Entity = Entity>(
  entityType: EntityType,
  entityId: string,
): Promise<EntityResponse<T>> {
  const result = await apiRequest<T>(
    `/api/${entityType}/${encodeURIComponent(entityId)}`,
  );
  return { data: result.data, etag: result.response.headers.get("ETag") };
}

export async function getRegistry(entityId: string): Promise<EntityRegistry> {
  const result = await apiRequest<EntityRegistry>(
    `/api/entities/${encodeURIComponent(entityId)}/registry`,
  );
  return result.data;
}

export async function patchEntity<T extends Entity = Entity>(
  entityType: EntityType,
  entityId: string,
  patch: EntityPatch,
  etag?: string,
): Promise<EntityResponse<T>> {
  const headers = new Headers();
  if (etag) {
    headers.set("If-Match", etag);
  }
  const result = await apiRequest<T>(
    `/api/${entityType}/${encodeURIComponent(entityId)}`,
    {
      ...jsonRequest(patch, headers),
      method: "PATCH",
    },
  );
  return { data: result.data, etag: result.response.headers.get("ETag") };
}

export interface UploadArtifactOptions {
  name?: string;
  linkEntityId?: string;
  relation?: "annotates" | "refers_to";
}

export async function uploadArtifact(
  file: File,
  options: UploadArtifactOptions = {},
): Promise<Entity> {
  const form = new FormData();
  form.append("file", file, file.name);
  if (options.name) {
    form.append("name", options.name);
  }
  if (options.linkEntityId) {
    form.append("link_entity_id", options.linkEntityId);
    form.append("relation", options.relation ?? "annotates");
  }
  const result = await apiRequest<Entity>("/api/artifacts/upload", {
    body: form,
    method: "POST",
  });
  return result.data;
}

export async function searchEntities(
  query: string,
  limit?: number,
): Promise<SearchResult[]> {
  const path = withQuery("/api/search", { q: query, limit });
  const result = await apiRequest<SearchResult[]>(path);
  return result.data;
}

export async function getLineageGraph(
  entityId: string,
  query: LineageQuery = {},
): Promise<LineageGraph> {
  const path = withQuery(
    `/api/entities/${encodeURIComponent(entityId)}/lineage`,
    {
      direction: query.direction,
      depth: query.depth,
      relations: query.relations?.length
        ? query.relations.join(",")
        : undefined,
      graph: "true",
      hydrate: query.hydrate ? "true" : undefined,
    },
  );
  const result = await apiRequest<LineageGraph>(path);
  return result.data;
}

export interface FabFlowRef {
  id: string;
  entity_type: EntityType;
  accession: string;
  name: string;
}

export interface FabFlowStep {
  id: string;
  accession: string;
  step_index: number;
  name: string;
  body: string;
  created_at: string;
  recipe: FabFlowRef | null;
  instrument: FabFlowRef | null;
}

/** A wafer's fab steps in process order, with recipe and machine resolved. */
export async function getFabFlow(entityId: string): Promise<FabFlowStep[]> {
  const result = await apiRequest<{ steps: FabFlowStep[] }>(
    `/api/entities/${encodeURIComponent(entityId)}/fab_flow`,
  );
  return result.data.steps;
}

/** Count of open review tasks, for the queue nav badge. */
export async function countOpenReviewTasks(): Promise<number> {
  const page = await listEntitiesPage("review_task", {
    limit: 1,
    filters: { status: "open" },
  });
  return page.total;
}

export interface Subscription {
  id: string;
  person_id: string;
  entity_type: EntityType;
  action: string;
  filters: Record<string, unknown>;
  created_at: string;
}

export async function listSubscriptions(
  personId?: string,
): Promise<Subscription[]> {
  const query = personId ? `?person_id=${encodeURIComponent(personId)}` : "";
  const result = await apiRequest<Subscription[]>(`/api/subscriptions${query}`);
  return result.data;
}

export async function createSubscription(input: {
  person_id?: string;
  entity_type: EntityType;
  action?: string;
  filters?: Record<string, unknown>;
}): Promise<Subscription> {
  const result = await apiRequest<Subscription>("/api/subscriptions", {
    ...jsonRequest(input),
    method: "POST",
  });
  return result.data;
}

export async function deleteSubscription(id: string): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL}/api/subscriptions/${encodeURIComponent(id)}`,
    { headers: requestHeaders(), method: "DELETE" },
  );
  if (!response.ok) {
    throw new Error(`Subscription delete failed (HTTP ${response.status})`);
  }
}

export async function postNotify(input: {
  person_ids: string[];
  entity_id: string;
  note?: string;
}): Promise<void> {
  await apiRequest("/api/notify", {
    ...jsonRequest(input),
    method: "POST",
  });
}

export async function getEntityLabel(entityId: string): Promise<string> {
  const result = await apiRequest<{ label: string }>(
    `/api/entities/${encodeURIComponent(entityId)}/label`,
  );
  return result.data.label;
}

export async function getPrinters(): Promise<string[]> {
  const result = await apiRequest<string[]>("/api/printers");
  return result.data;
}

export async function printLabel(
  entityId: string,
  options: PrintLabelOptions = {},
): Promise<PrintLabelResult> {
  const result = await apiRequest<PrintLabelResult>(
    `/api/entities/${encodeURIComponent(entityId)}/print-label`,
    {
      ...jsonRequest({
        printer: options.printer,
        label_format: options.labelFormat,
      }),
      method: "POST",
    },
  );
  return result.data;
}

export async function getEvents(query: EventQuery = {}): Promise<EventPage> {
  const path = withQuery("/api/events", {
    after: query.after,
    limit: query.limit,
  });
  const result = await apiRequest<EventPage>(path);
  return result.data;
}

export async function getFeed(query: FeedQuery = {}): Promise<FeedPage> {
  const path = withQuery("/api/feed", {
    before: query.before,
    limit: query.limit,
    actions: query.actions,
    actor: query.actor,
    entity_type: query.entityType,
    since: query.since,
    until: query.until,
  });
  const result = await apiRequest<FeedPage>(path);
  return result.data;
}

export async function getWhoami(): Promise<Whoami> {
  const result = await apiRequest<Whoami>("/api/whoami");
  return result.data;
}

export async function getEntityEvents(
  entityId: string,
  query: EventQuery = {},
): Promise<EventPage> {
  const path = withQuery(
    `/api/entities/${encodeURIComponent(entityId)}/events`,
    {
      after: query.after,
      limit: query.limit,
    },
  );
  const result = await apiRequest<EventPage>(path);
  return result.data;
}

export async function getSchema(): Promise<CatalogSchema> {
  const result = await apiRequest<CatalogSchema>("/api/schema");
  return result.data;
}

export async function getTemplates(): Promise<EntityTemplate[]> {
  const result = await apiRequest<EntityTemplate[]>("/api/templates");
  return result.data;
}

export async function createEdge(input: CreateEdgeInput): Promise<CreatedEdge> {
  const result = await apiRequest<CreatedEdge>("/api/edges", {
    ...jsonRequest(input),
    method: "POST",
  });
  return result.data;
}

export async function resolveAccession<T extends Entity = Entity>(
  accession: string,
): Promise<EntityResponse<T>> {
  const result = await apiRequest<T>(`/api/e/${encodeURIComponent(accession)}`);
  return { data: result.data, etag: result.response.headers.get("ETag") };
}

export function parseAccessionUrl(value: string): string | null {
  const input = value.trim();
  if (!input) {
    return null;
  }

  const isUrl = input.startsWith("/") || /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  if (!isUrl) {
    return input;
  }

  try {
    const parsed = new URL(input, "http://autolab.local");
    const match = parsed.pathname.match(/^\/e\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

// ---- Projects: goals, milestones, and the progress report ----

export type ProjectItemKind = "goal" | "milestone";

export interface ProjectItem {
  id: string;
  project_id: string;
  kind: ProjectItemKind;
  title: string;
  position: number;
  target_date: string | null;
  done_at: string | null;
  done_by_id: string | null;
  created_at: string;
  created_by_id: string | null;
}

export interface ProjectWorkBlock {
  count: number;
  recent: Entity[];
}

export interface ProjectProgress {
  goals_done: number;
  goals_total: number;
  milestones_done: number;
  milestones_total: number;
  overdue_milestones: number;
}

export type ResultValue = number | string;

export interface ResultColumn {
  key: string;
  label: string;
}

export interface ResultBrief {
  id: string;
  accession: string;
  name: string;
}

export interface ResultRow {
  analysis: ResultBrief & { created_at: string };
  project: ResultBrief | null;
  experiment: ResultBrief | null;
  results: Record<string, ResultValue>;
}

export interface ResultSummaryTable {
  summary: ResultBrief & { columns: ResultColumn[] };
  // Union of result keys across rows, first seen order.
  keys: string[];
  // Effective columns: the stored list, or one per key.
  columns: ResultColumn[];
  rows: ResultRow[];
}

export async function getResultSummaryTable(
  summaryId: string,
): Promise<ResultSummaryTable> {
  const result = await apiRequest<ResultSummaryTable>(
    `/api/result_summary/${encodeURIComponent(summaryId)}/table`,
  );
  return result.data;
}

export interface ProjectReport {
  project: Entity;
  lead: Entity | null;
  goals: ProjectItem[];
  milestones: ProjectItem[];
  progress: ProjectProgress;
  work: Record<string, ProjectWorkBlock>;
  events: EventRecord[];
}

function projectPath(projectId: string, suffix: string): string {
  return `/api/project/${encodeURIComponent(projectId)}/${suffix}`;
}

export async function getProjectReport(
  projectId: string,
): Promise<ProjectReport> {
  const result = await apiRequest<ProjectReport>(projectPath(projectId, "report"));
  return result.data;
}

export async function createProjectItem(
  projectId: string,
  input: { kind: ProjectItemKind; title: string; target_date?: string | null },
): Promise<ProjectItem> {
  const result = await apiRequest<ProjectItem>(projectPath(projectId, "items"), {
    ...jsonRequest(input),
    method: "POST",
  });
  return result.data;
}

export async function patchProjectItem(
  projectId: string,
  itemId: string,
  patch: { title?: string; target_date?: string | null; done?: boolean },
): Promise<ProjectItem> {
  const result = await apiRequest<ProjectItem>(
    projectPath(projectId, `items/${encodeURIComponent(itemId)}`),
    { ...jsonRequest(patch), method: "PATCH" },
  );
  return result.data;
}

export async function setProjectItemDone(
  projectId: string,
  itemId: string,
  done: boolean,
): Promise<ProjectItem> {
  const result = await apiRequest<ProjectItem>(
    projectPath(projectId, `items/${encodeURIComponent(itemId)}/done`),
    { ...jsonRequest({ done }), method: "POST" },
  );
  return result.data;
}

export async function reorderProjectItems(
  projectId: string,
  kind: ProjectItemKind,
  itemIds: string[],
): Promise<ProjectItem[]> {
  const result = await apiRequest<ProjectItem[]>(
    projectPath(projectId, "items/reorder"),
    { ...jsonRequest({ kind, item_ids: itemIds }), method: "POST" },
  );
  return result.data;
}

export async function deleteProjectItem(
  projectId: string,
  itemId: string,
): Promise<void> {
  // 204 has no body, so this cannot go through apiRequest's JSON parse.
  const response = await fetch(
    `${API_BASE_URL}${projectPath(projectId, `items/${encodeURIComponent(itemId)}`)}`,
    { headers: requestHeaders(), method: "DELETE" },
  );
  if (!response.ok) {
    let detail: unknown = response.statusText;
    try {
      detail =
        ((await response.json()) as { detail?: unknown }).detail ?? detail;
    } catch {
      // No JSON body on some failures.
    }
    throw new ApiError(response.status, detail);
  }
}

// Every record of a type, paged through the endpoint's 100-row cap. Meant
// for small reference lists (projects, people) that back dropdowns.
export async function listAllEntities<T extends Entity = Entity>(
  entityType: EntityType,
  pagination: Omit<Pagination, "limit" | "offset"> = {},
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await listEntitiesPage<T>(entityType, {
      ...pagination,
      limit: 100,
      offset,
    });
    rows.push(...page.rows);
    offset += page.rows.length;
    if (page.rows.length === 0 || offset >= page.total) {
      return rows;
    }
  }
}

// ---- Setup designer: RF layouts and evaluation ----

export interface LayoutStage {
  id: string;
  label: string;
  temp_k: number;
}

export interface LayoutPart {
  id: string;
  type: string;
  stage: string;
  instrument_id?: string;
  // Switches only: port number (as a string key) -> branch chain id.
  ports?: Record<string, string>;
  selected_port?: number | null;
  // Fibers: the feedline whose device the fiber illuminates.
  feedline?: string;
}

export interface LayoutChain {
  id: string;
  label: string;
  direction: "input" | "output";
  feedline?: string;
  parts: LayoutPart[];
}

// device_id is a catalog device id, or THROUGH_DEVICE for a through line
// (no chip; used to calibrate transmission).
export const THROUGH_DEVICE = "through";

export interface FeedlineBinding {
  device_id?: string;
}

export interface Layout {
  version: 1;
  frequency_ghz: number;
  stages: LayoutStage[];
  chains: LayoutChain[];
  optical: LayoutPart[];
  // Feedline label -> which catalog device sits on it.
  feedlines?: Record<string, FeedlineBinding>;
  notes: string;
}

export interface RfPart {
  id: string;
  label: string;
  category: string;
  symbol: string;
  gain_db: number | null;
  noise_temp_k: number | null;
  ports: number;
  bindable: boolean;
  directions: ("input" | "output")[];
  default_stage: string;
  // Optical parts that end on a device (fibers) rather than a stage.
  destination?: "device";
}

export interface RfLibrary {
  version: number;
  parts: RfPart[];
}

export interface EvaluatedPart {
  id: string;
  type: string;
  stage: string;
  gain_db: number;
  noise_k: number;
  source: "library" | "instrument" | "missing_instrument";
  line_noise_after_k?: number;
  gain_ahead_db?: number;
  contribution_k?: number;
}

export interface EvaluatedSide {
  active: boolean;
  chain_path: string[];
  attenuation_db?: number;
  noise_temp_at_device_k?: number;
  gain_db?: number;
  added_noise_k?: number;
  parts?: EvaluatedPart[];
}

export interface LayoutWarning {
  part?: string;
  chain?: string;
  feedline?: string;
  message: string;
}

export interface EvaluatedDevice {
  id: string;
  name?: string;
  accession?: string;
  missing?: boolean;
  through?: boolean;
}

export interface LayoutEvaluation {
  evaluator_version: number;
  library_version: number;
  frequency_ghz: number;
  convention: string;
  assumptions: string[];
  feedlines: Record<
    string,
    { input: EvaluatedSide | null; output: EvaluatedSide | null; device?: EvaluatedDevice | null }
  >;
  warnings: LayoutWarning[];
  evaluated_at?: string;
}

export interface SetupLayoutResponse {
  layout: Layout | Record<string, never>;
  evaluation: LayoutEvaluation | null;
  saved_evaluation: LayoutEvaluation | null;
}

export async function getRfParts(): Promise<RfLibrary> {
  const result = await apiRequest<RfLibrary>("/api/rf/parts");
  return result.data;
}

export async function evaluateLayout(layout: Layout): Promise<LayoutEvaluation> {
  const result = await apiRequest<LayoutEvaluation>("/api/rf/evaluate", {
    ...jsonRequest({ layout }),
    method: "POST",
  });
  return result.data;
}

export async function getSetupLayout(
  setupId: string,
): Promise<{ data: SetupLayoutResponse; etag: string | null }> {
  const result = await apiRequest<SetupLayoutResponse>(
    `/api/experiment_setup/${encodeURIComponent(setupId)}/layout`,
  );
  return { data: result.data, etag: result.response.headers.get("ETag") };
}

export async function putSetupLayout(
  setupId: string,
  layout: Layout,
  etag?: string | null,
): Promise<{ data: SetupLayoutResponse; etag: string | null }> {
  const headers = new Headers();
  if (etag) {
    headers.set("If-Match", etag);
  }
  const result = await apiRequest<SetupLayoutResponse>(
    `/api/experiment_setup/${encodeURIComponent(setupId)}/layout`,
    { ...jsonRequest({ layout }, headers), method: "PUT" },
  );
  return { data: result.data, etag: result.response.headers.get("ETag") };
}
