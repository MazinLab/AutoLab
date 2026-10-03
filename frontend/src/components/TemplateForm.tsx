import {
  type ChangeEvent,
  type FormEvent,
  Fragment,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  createEntity,
  getEntity,
  getLineageGraph,
  getPrinters,
  listAllEntities,
  listEntities,
  postNotify,
  printLabel,
  resolveAccession,
  searchEntities,
  uploadArtifact,
  type EdgeRelation,
  type Entity,
  type EntityInput,
  type EntityLink,
  type EntityTemplate,
  type EntityType,
  type Layout,
  type LineageEdge,
  type LineageNode,
  type SearchResult,
  type TemplateField,
  type ResultValue,
} from "../api/client";
import { enqueueCreate, isNetworkFailure } from "../offline/outbox";
import { AccessionScanner } from "../pages/scan";
import { setColdestStageTemp } from "../pages/setup/rfLayout";
import { StartFromPicker, type StartFromChoice } from "../pages/setup/StartFromPicker";
import { MarkdownEditor } from "./MarkdownEditor";
import { ResultsFieldEditor } from "./ResultsFieldEditor";
import { NotifyPicker, type NotifyTarget } from "./NotifyPicker";

interface TemplateFormProps {
  template: EntityTemplate;
  onCreated?: (entity: Entity) => void;
  // Batch submissions (Copies > 1) report every created record; without this
  // handler the form falls back to onCreated with the first record.
  onBatchCreated?: (entities: Entity[]) => void;
  onLabelError?: (message: string) => void;
  // The automatic label on create reached a printer (named).
  onLabelPrinted?: (printer: string) => void;
  // Prefill for clone/supersede flows: starting field values and body text.
  initialValues?: Record<string, string>;
  initialBody?: string;
  // Links added to every created record beyond the entity-field links
  // (e.g. a supersedes edge when replacing a record).
  extraLinks?: EntityLink[];
  // Pre-picked entity references (clone/supersede prefill), keyed by
  // template field name.
  initialEntityRefs?: Record<string, SearchResult>;
  // Names of initial refs the user chose deliberately (e.g. "?project=" in
  // the URL). Explicit picks are never overwritten by reference prefill.
  initialExplicitFields?: string[];
  // Setup designer: a cloned source's layout, offered as the selected
  // "Start from" option.
  initialLayout?: { layout: Layout; sourceAccession: string } | null;
  // Clone prefill for "results" fields (objects cannot ride in initialValues).
  initialResults?: Record<string, ResultValue>;
}

interface EntityFieldFilter {
  field: string;
  value: string;
}

interface EntityFieldPickerProps {
  disabled: boolean;
  field: TemplateField;
  onPick: (entity: SearchResult | null) => void;
  targetEntityTypes: EntityType[];
  where?: EntityFieldFilter;
  scannable?: boolean;
  // Pre-picked entity for clone/supersede prefill; the parent form already
  // holds it in selectedEntities, this just makes the select show it.
  initialSelection?: SearchResult | null;
}

interface EntityFieldRule {
  targetEntityTypes: EntityType[];
  // Link the picked entity to the new record with this edge relation…
  outboundRelation?: EdgeRelation;
  // …or store its id in this payload column instead of creating an edge
  // (e.g. agent.operator_id is a real column on the agent table).
  payloadField?: string;
  // Keep only entities whose field matches (entities missing the field
  // entirely stay visible so pre-category records are still selectable).
  where?: EntityFieldFilter;
  // Copy fields from the picked entity into the new record: source field on
  // the picked entity -> destination field. Destinations that are visible
  // form fields update in place (still editable); others ride along in the
  // payload.
  autofill?: Record<string, string>;
  // QR scan (camera + manual accession entry) is offered on every entity
  // field by default; set false to opt a field out.
  scan?: boolean;
  // Picking this entity suggests the next step_index: highest step_index
  // among fab_steps already referring to the pick, plus one. Suggestion
  // only — the field stays editable and a value the user typed is kept.
  nextStepIndex?: boolean;
  // "dropdown" lists every entity of the target type in a plain select
  // (small reference lists such as projects); "search" (default) is the
  // recents + type-ahead + scan picker.
  picker?: "search" | "dropdown";
}

const EXPERIMENTAL_EQUIPMENT: EntityFieldFilter = {
  field: "category",
  value: "experimental",
};
const FAB_EQUIPMENT: EntityFieldFilter = { field: "category", value: "fab" };
const TESTBED: EntityFieldFilter = { field: "category", value: "testbed" };

// Membership is a column (project_id), never an edge: see the projects spec.
const PROJECT_RULE: EntityFieldRule = {
  targetEntityTypes: ["project"],
  payloadField: "project_id",
  picker: "dropdown",
  scan: false,
};
// Reference picks carry their own project into the project dropdown.
const INHERIT_PROJECT = { project_id: "project" };

const ENTITY_FIELD_RULES: Record<string, EntityFieldRule> = {
  "Wafer:substrate": {
    targetEntityTypes: ["substrate_batch"],
    outboundRelation: "refers_to",
    scan: true,
    autofill: { material: "material", diameter_mm: "diameter_mm" },
  },
  "Wafer:design": {
    targetEntityTypes: ["design"],
    outboundRelation: "derived_from",
  },
  "Device:wafer": {
    targetEntityTypes: ["wafer"],
    outboundRelation: "derived_from",
    scan: true,
    autofill: INHERIT_PROJECT,
  },
  "Agent:operator": {
    targetEntityTypes: ["person"],
    payloadField: "operator_id",
  },
  "Project:lead": {
    targetEntityTypes: ["person"],
    payloadField: "lead_id",
    scan: false,
  },
  "Wafer:project": PROJECT_RULE,
  "Device:project": PROJECT_RULE,
  "Experiment Setup:project": PROJECT_RULE,
  "Experiment:project": PROJECT_RULE,
  "Analysis:project": PROJECT_RULE,
  "Design:project": PROJECT_RULE,
  "Fab Recipe:project": PROJECT_RULE,
  "Substrate Batch:project": PROJECT_RULE,
  "Analysis Software:project": PROJECT_RULE,
  "Experiment Setup:instrument": {
    targetEntityTypes: ["instrument"],
    outboundRelation: "performed_on",
    where: TESTBED,
  },
  "Experiment:sample": {
    targetEntityTypes: ["device", "wafer"],
    outboundRelation: "refers_to",
    autofill: INHERIT_PROJECT,
  },
  "Analysis:experiment": {
    targetEntityTypes: ["note"],
    outboundRelation: "derived_from",
    where: { field: "template", value: "Experiment" },
    autofill: INHERIT_PROJECT,
  },
  "Analysis:software": {
    targetEntityTypes: ["software"],
    outboundRelation: "refers_to",
  },
  // Membership edge; more summaries can be joined from the record pages.
  "Analysis:result_summary": {
    targetEntityTypes: ["result_summary"],
    outboundRelation: "refers_to",
    scan: false,
  },
  "Experiment:instrument": {
    targetEntityTypes: ["instrument"],
    outboundRelation: "refers_to",
    where: EXPERIMENTAL_EQUIPMENT,
  },
  "Experiment:setup": {
    targetEntityTypes: ["experiment_setup"],
    outboundRelation: "refers_to",
    autofill: INHERIT_PROJECT,
  },
  "Maintenance:instrument": {
    targetEntityTypes: ["instrument"],
    outboundRelation: "refers_to",
  },
  "Fab Note:wafer": {
    targetEntityTypes: ["wafer"],
    outboundRelation: "refers_to",
  },
  "Wafer Measurement:wafer": {
    targetEntityTypes: ["wafer"],
    outboundRelation: "refers_to",
  },
  "Wafer Measurement:instrument": {
    targetEntityTypes: ["instrument"],
    outboundRelation: "performed_on",
    where: FAB_EQUIPMENT,
  },
  "Fab Step:wafer": {
    targetEntityTypes: ["wafer"],
    outboundRelation: "refers_to",
    nextStepIndex: true,
  },
  "Fab Step:recipe": {
    targetEntityTypes: ["fab_recipe"],
    outboundRelation: "refers_to",
  },
  "Fab Step:instrument": {
    targetEntityTypes: ["instrument"],
    outboundRelation: "performed_on",
    where: FAB_EQUIPMENT,
  },
};

// Only entities that map to a physical object get a QR label at creation
// (spec 2026-07-18-lab-catalog-app-design.md line 99). Notes, fab steps, and
// cooldowns have nothing physical to label and must never auto-spool one.
// Devices are deliberately absent: a 2x1.25in label does not fit a device
// box, so those are printed on demand from the entity page instead.
// Each log record is a new event: "Create another" keeps its links (wafer,
// recipe, instrument) but not the previous title, log text, or results.
const LOG_ENTITY_TYPES = new Set<EntityType>([
  "fab_step",
  "measurement_run",
  "note",
]);

const LABELABLE_ENTITY_TYPES = new Set<EntityType>([
  "substrate_batch",
  "wafer",
  "instrument",
]);

function entityFieldRule(
  template: EntityTemplate,
  field: TemplateField,
): EntityFieldRule {
  const rule = ENTITY_FIELD_RULES[`${template.name}:${field.name}`];
  if (!rule) {
    throw new Error(
      `${template.name}.${field.name} is missing entity reference semantics.`,
    );
  }
  return rule;
}

/* A project reference known only by id (inherited from a picked record or
   a deep link). The dropdown resolves the label once its options load. */
export function projectRefStub(projectId: string): SearchResult {
  return { id: projectId, entity_type: "project", accession: "", name: "" };
}

/* Point a template at a record it can reference: the first entity field
   whose rule accepts that record's type. Backs "?for=<id>" deep links, e.g.
   "+ Add step" from a wafer landing on a Fab Step form with the wafer set.
   The target's project rides along into the project dropdown. */
export function entityRefsForTarget(
  template: EntityTemplate,
  target: Entity,
): Record<string, SearchResult> {
  const refs: Record<string, SearchResult> = {};
  for (const field of template.fields) {
    if (field.type !== "entity") {
      continue;
    }
    const rule = ENTITY_FIELD_RULES[`${template.name}:${field.name}`];
    if (rule?.targetEntityTypes.includes(target.entity_type)) {
      refs[field.name] = {
        id: target.id,
        entity_type: target.entity_type,
        accession: target.accession,
        name: target.name,
      };
      break;
    }
  }
  const inherited = inheritedProjectRefs(template, target);
  return { ...inherited, ...refs };
}

/* The project dropdown seeded from a source record's project_id (clone,
   supersede, "?for=" target). Empty when the template has no project field
   or the source carries no project. */
export function inheritedProjectRefs(
  template: EntityTemplate,
  source: Entity,
): Record<string, SearchResult> {
  const projectId = source.project_id;
  if (typeof projectId !== "string" || !projectId) {
    return {};
  }
  const refs: Record<string, SearchResult> = {};
  for (const field of template.fields) {
    if (
      field.type === "entity" &&
      ENTITY_FIELD_RULES[`${template.name}:${field.name}`] === PROJECT_RULE
    ) {
      refs[field.name] = projectRefStub(projectId);
    }
  }
  return refs;
}

// Every edge relation any rule links through — the relations a clone must
// fetch to restore the source's entity references.
export const CLONE_EDGE_RELATIONS: EdgeRelation[] = [
  ...new Set(
    Object.values(ENTITY_FIELD_RULES)
      .map((rule) => rule.outboundRelation)
      .filter((relation): relation is EdgeRelation => Boolean(relation)),
  ),
];

/* Map a clone source's outbound depth-1 edges back onto the template's
   entity fields (Autolab-8oc): entity references are edges on the source,
   not columns, so scalar prefill alone loses them. payloadField rules
   (agent.operator_id) ride the scalar prefill instead. */
export function cloneEntityRefs(
  template: EntityTemplate,
  graph: { nodes: LineageNode[]; edges: LineageEdge[] },
  sourceId: string,
): Record<string, SearchResult> {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const refs: Record<string, SearchResult> = {};
  for (const field of template.fields) {
    if (field.type !== "entity") {
      continue;
    }
    const rule = ENTITY_FIELD_RULES[`${template.name}:${field.name}`];
    if (!rule?.outboundRelation) {
      continue;
    }
    const edge = graph.edges.find((candidate) => {
      if (
        candidate.src_id !== sourceId ||
        candidate.relation !== rule.outboundRelation
      ) {
        return false;
      }
      const node = nodesById.get(candidate.dst_id);
      return (
        node !== undefined && rule.targetEntityTypes.includes(node.entity_type)
      );
    });
    if (!edge) {
      continue;
    }
    const node = nodesById.get(edge.dst_id);
    if (node) {
      refs[field.name] = {
        id: node.id,
        accession: node.accession,
        entity_type: node.entity_type,
        name: node.name ?? "",
      } as SearchResult;
    }
  }
  return refs;
}

function describeTypes(targetEntityTypes: EntityType[]): string {
  return targetEntityTypes
    .map((entityType) => entityType.replaceAll("_", " "))
    .join(" or ");
}

/* What a picker option reads as. People pick records by name, so the
   accession only appears when a record has none — a list of "STEP-2026-0004"
   tells nobody which step they are choosing. */
export function optionLabel(option: SearchResult): string {
  if (option.name) {
    return option.name;
  }
  // Setups have no name; their start time is the natural identifier.
  const startedAt = (option as unknown as Record<string, unknown>).started_at;
  if (typeof startedAt === "string") {
    return `${option.accession} — ${new Date(startedAt).toLocaleDateString()}`;
  }
  return option.accession;
}

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 25;

// A `where` rule rejects entities whose field is present and different;
// entities missing the field entirely pass (pre-category records stay usable).
function violatesWhere(
  candidate: SearchResult,
  where: EntityFieldFilter | undefined,
): boolean {
  if (!where) {
    return false;
  }
  const value = (candidate as unknown as Record<string, unknown>)[where.field];
  return (
    value !== null &&
    value !== undefined &&
    value !== "" &&
    value !== where.value
  );
}

function whereRejection(
  candidate: SearchResult,
  where: EntityFieldFilter,
): string {
  const actual = (candidate as unknown as Record<string, unknown>)[where.field];
  return (
    `${candidate.accession} has ${where.field.replaceAll("_", " ")} ` +
    `${String(actual)}; expected ${where.value}.`
  );
}

function RecentEntityPicker({
  disabled,
  field,
  onPick,
  targetEntityTypes,
  where,
  scannable = false,
  initialSelection = null,
}: EntityFieldPickerProps): ReactElement {
  const selectId = useId();
  const [options, setOptions] = useState<SearchResult[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(initialSelection?.id ?? "");
  const [isScanning, setIsScanning] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(
    null,
  );
  const [pickError, setPickError] = useState<string | null>(null);
  // Full records fetched for scan and type-ahead picks, so re-picking the
  // same entity never refetches.
  const detailCacheRef = useRef(new Map<string, SearchResult>());

  async function handleScannedAccession(accession: string): Promise<void> {
    setScanError(null);
    try {
      const resolved = await resolveAccession(accession);
      const entity = resolved.data;
      if (!targetEntityTypes.includes(entity.entity_type)) {
        setScanError(
          `${entity.accession} is a ${entity.entity_type.replaceAll("_", " ")}; ` +
            `expected ${describeTypes(targetEntityTypes)}.`,
        );
        return;
      }
      if (violatesWhere(entity, where)) {
        setScanError(whereRejection(entity, where as EntityFieldFilter));
        return;
      }
      detailCacheRef.current.set(entity.id, entity);
      setOptions((current) =>
        current?.some((option) => option.id === entity.id)
          ? current
          : [entity, ...(current ?? [])],
      );
      setQuery("");
      setSearchResults(null);
      setSelectedId(entity.id);
      onPick(entity);
      setIsScanning(false);
    } catch (error: unknown) {
      setScanError(
        error instanceof Error
          ? error.message
          : "That code could not be resolved.",
      );
    }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      targetEntityTypes.map((entityType) =>
        listEntities(entityType, { limit: 100, order: "desc" }),
      ),
    )
      .then((lists) => {
        if (!cancelled) {
          const recents = lists
            .flat()
            .filter(
              (option) =>
                !where ||
                !option[where.field] ||
                option[where.field] === where.value,
            )
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
          setOptions(
            initialSelection &&
              !recents.some((option) => option.id === initialSelection.id)
              ? [initialSelection, ...recents]
              : recents,
          );
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Recent records could not be loaded.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [targetEntityTypes, where]);

  // Debounced type-ahead: while the query is non-empty the select shows
  // matching search hits of the field's target types instead of the recents.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchEntities(trimmed, SEARCH_LIMIT)
        .then((results) => {
          if (!cancelled) {
            setSearchResults(
              results.filter((result) =>
                targetEntityTypes.includes(result.entity_type),
              ),
            );
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSearchResults([]);
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, targetEntityTypes]);

  const displayedOptions = searchResults ?? options;

  async function pick(entityId: string): Promise<void> {
    setPickError(null);
    const match =
      displayedOptions?.find((option) => option.id === entityId) ?? null;
    if (!match) {
      setSelectedId(entityId);
      onPick(null);
      return;
    }
    let resolved: SearchResult = match;
    if (searchResults) {
      // Search hits carry no field data, so the rule's `where` constraint
      // and autofill need the full record; recents already have it.
      const cached = detailCacheRef.current.get(match.id);
      if (cached) {
        resolved = cached;
      } else {
        try {
          const response = await getEntity(match.entity_type, match.id);
          resolved = response.data;
          detailCacheRef.current.set(match.id, resolved);
        } catch (error: unknown) {
          setSelectedId("");
          onPick(null);
          setPickError(
            error instanceof Error
              ? error.message
              : `${match.accession} could not be loaded.`,
          );
          return;
        }
      }
      if (violatesWhere(resolved, where)) {
        setSelectedId("");
        onPick(null);
        setPickError(whereRejection(resolved, where as EntityFieldFilter));
        return;
      }
      // Keep a search pick selectable after the query is cleared and the
      // select falls back to the recent list.
      setOptions((current) =>
        current?.some((option) => option.id === resolved.id)
          ? current
          : [resolved, ...(current ?? [])],
      );
    }
    setSelectedId(entityId);
    onPick(resolved);
  }

  const showType = targetEntityTypes.length > 1;
  return (
    <div className="template-field entity-field">
      <label htmlFor={selectId}>
        {field.label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <select
        disabled={disabled || displayedOptions === null}
        id={selectId}
        onChange={(event) => void pick(event.target.value)}
        required={field.required}
        value={selectedId}
      >
        <option value="">
          {displayedOptions === null
            ? "Loading recent records…"
            : searchResults
              ? searchResults.length === 0
                ? "No matches"
                : `Select a match for “${query.trim()}”`
              : `Select ${describeTypes(targetEntityTypes)}…`}
        </option>
        {displayedOptions?.map((option) => (
          <option key={option.id} value={option.id}>
            {optionLabel(option)}
            {showType ? ` (${option.entity_type.replaceAll("_", " ")})` : ""}
          </option>
        ))}
      </select>
      <div className="entity-field-actions">
        <button
          className="text-button search-toggle"
          disabled={disabled}
          onClick={() => {
            setIsSearching((searching) => {
              if (searching) {
                // Closing search drops the query so the select falls back to
                // the recents list instead of a stale hit set.
                setQuery("");
                setSearchResults(null);
              }
              return !searching;
            });
          }}
          type="button"
        >
          {isSearching ? "Hide search" : "Search all"}
        </button>
        {scannable ? (
          <button
            className="text-button scan-toggle"
            disabled={disabled}
            onClick={() => {
              setIsScanning((scanning) => !scanning);
              setScanError(null);
            }}
            type="button"
          >
            {isScanning ? "Hide scanner" : "Scan QR label"}
          </button>
        ) : null}
      </div>
      {isSearching ? (
        <input
          aria-label={`Search ${field.label}`}
          className="entity-search"
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${describeTypes(targetEntityTypes)}…`}
          type="search"
          value={query}
        />
      ) : null}
      {isScanning ? (
        <AccessionScanner
          disabled={disabled}
          inputLabel="Accession"
          onAccession={(accession) => void handleScannedAccession(accession)}
          submitLabel="Use"
        />
      ) : null}
      {scanError ? <p className="field-error">{scanError}</p> : null}
      {pickError ? <p className="field-error">{pickError}</p> : null}
      {loadError ? <p className="field-error">{loadError}</p> : null}
    </div>
  );
}

// Dropdown option lists are tiny reference tables (projects) shared by every
// form on the page, so one fetch per type per page load is enough.
const dropdownOptionsCache = new Map<EntityType, Promise<SearchResult[]>>();

const PROJECT_STATUS_ORDER: Record<string, number> = {
  active: 0,
  on_hold: 1,
  completed: 2,
};

function projectStatus(option: SearchResult): string {
  const status = (option as unknown as Record<string, unknown>).status;
  return typeof status === "string" && status ? status : "active";
}

export function sortDropdownOptions(
  entityType: EntityType,
  options: SearchResult[],
): SearchResult[] {
  const sorted = [...options];
  if (entityType === "project") {
    sorted.sort((a, b) => {
      const byStatus =
        (PROJECT_STATUS_ORDER[projectStatus(a)] ?? 9) -
        (PROJECT_STATUS_ORDER[projectStatus(b)] ?? 9);
      return byStatus !== 0 ? byStatus : optionLabel(a).localeCompare(optionLabel(b));
    });
  } else {
    sorted.sort((a, b) => optionLabel(a).localeCompare(optionLabel(b)));
  }
  return sorted;
}

export function loadDropdownOptions(
  entityType: EntityType,
): Promise<SearchResult[]> {
  let pending = dropdownOptionsCache.get(entityType);
  if (!pending) {
    pending = listAllEntities(entityType).then((rows) =>
      sortDropdownOptions(entityType, rows),
    );
    // A failed load must not poison later forms.
    pending.catch(() => dropdownOptionsCache.delete(entityType));
    dropdownOptionsCache.set(entityType, pending);
  }
  return pending;
}

export function resetDropdownOptionsCache(): void {
  dropdownOptionsCache.clear();
}

interface DropdownEntityPickerProps {
  disabled: boolean;
  field: TemplateField;
  options: SearchResult[] | null;
  loadError: string | null;
  selectedId: string;
  onPick: (entity: SearchResult | null) => void;
  hint?: string | null;
  // Optional fields offer "None"; required ones only the placeholder.
  allowNone?: boolean;
  idOverride?: string;
}

export function DropdownEntityPicker({
  disabled,
  field,
  options,
  loadError,
  selectedId,
  onPick,
  hint = null,
  allowNone = true,
  idOverride,
}: DropdownEntityPickerProps): ReactElement {
  const generatedId = useId();
  const selectId = idOverride ?? generatedId;
  const isProject = options?.some((option) => "status" in option) ?? false;
  const open = options?.filter((option) => projectStatus(option) !== "completed") ?? [];
  const completed =
    options?.filter((option) => projectStatus(option) === "completed") ?? [];
  const known = options?.some((option) => option.id === selectedId) ?? false;
  return (
    <div className="template-field entity-field">
      <label htmlFor={selectId}>
        {field.label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <select
        disabled={disabled || options === null}
        id={selectId}
        onChange={(event) => {
          const id = event.target.value;
          onPick(options?.find((option) => option.id === id) ?? null);
        }}
        required={field.required}
        value={selectedId}
      >
        <option value="">
          {options === null
            ? `Loading ${field.label.toLowerCase()}…`
            : allowNone || !field.required
              ? "None"
              : `Select ${field.label.toLowerCase()}…`}
        </option>
        {/* A prefilled id that is not (yet) in the option list stays
            selected instead of being dropped. */}
        {selectedId && !known ? (
          <option value={selectedId}>{options === null ? "…" : selectedId}</option>
        ) : null}
        {(isProject ? open : (options ?? [])).map((option) => (
          <option key={option.id} value={option.id}>
            {optionLabel(option)}
            {isProject && projectStatus(option) === "on_hold" ? " (on hold)" : ""}
          </option>
        ))}
        {isProject && completed.length > 0 ? (
          <optgroup label="Completed">
            {completed.map((option) => (
              <option key={option.id} value={option.id}>
                {optionLabel(option)}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
      {hint ? <p className="field-hint">{hint}</p> : null}
      {loadError ? <p className="field-error">{loadError}</p> : null}
    </div>
  );
}

function inputType(field: TemplateField): "datetime-local" | "number" | "text" {
  if (field.type === "datetime") {
    return "datetime-local";
  }
  return field.type === "number" ? "number" : "text";
}

function convertFieldValue(field: TemplateField, value: string): unknown {
  if (field.type === "number") {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
      throw new Error(`${field.label} must be a number.`);
    }
    return numberValue;
  }
  if (field.type === "datetime") {
    const datetimeValue = new Date(value);
    if (Number.isNaN(datetimeValue.getTime())) {
      throw new Error(`${field.label} must be a valid date and time.`);
    }
    return datetimeValue.toISOString();
  }
  return value;
}

function noteName(body: string, templateName: string): string {
  return body.trim().split(/\r?\n/, 1)[0]?.trim() || templateName;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} kB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TemplateForm({
  template,
  onCreated,
  onBatchCreated,
  onLabelError,
  onLabelPrinted,
  initialValues,
  initialBody,
  extraLinks,
  initialEntityRefs,
  initialExplicitFields,
  initialLayout = null,
  initialResults,
}: TemplateFormProps): ReactElement {
  const [startFrom, setStartFrom] = useState<StartFromChoice | null>(null);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seeded: Record<string, string> = { ...(initialValues ?? {}) };
    for (const field of template.fields) {
      if (field.type === "select" && field.default && !(field.name in seeded)) {
        seeded[field.name] = field.default;
      }
    }
    return seeded;
  });
  const [resultsValues, setResultsValues] = useState<
    Record<string, Record<string, ResultValue>>
  >(() => {
    const seeded: Record<string, Record<string, ResultValue>> = {};
    for (const field of template.fields) {
      if (field.type === "results" && initialResults) {
        seeded[field.name] = initialResults;
      }
    }
    return seeded;
  });
  const [selectedEntities, setSelectedEntities] = useState<
    Record<string, SearchResult | null>
  >(() => initialEntityRefs ?? {});
  // Fields the user chose deliberately; reference prefill never overrides
  // them (a wafer pick must not silently move a chosen project).
  const [explicitFields, setExplicitFields] = useState<Set<string>>(
    () => new Set(initialExplicitFields ?? []),
  );
  const [dropdownOptions, setDropdownOptions] = useState<
    Record<string, SearchResult[] | null>
  >({});
  const [dropdownErrors, setDropdownErrors] = useState<Record<string, string>>(
    {},
  );

  const dropdownFields = template.fields.filter(
    (field) =>
      field.type === "entity" && entityFieldRule(template, field).picker === "dropdown",
  );
  const dropdownTypes = dropdownFields
    .map((field) => entityFieldRule(template, field).targetEntityTypes[0])
    .join(",");
  useEffect(() => {
    let cancelled = false;
    for (const field of dropdownFields) {
      const entityType = entityFieldRule(template, field).targetEntityTypes[0];
      loadDropdownOptions(entityType)
        .then((options) => {
          if (cancelled) {
            return;
          }
          setDropdownOptions((current) => ({ ...current, [field.name]: options }));
          // A stub seeded by id alone gains its record once options exist.
          setSelectedEntities((current) => {
            const picked = current[field.name];
            const match = picked && options.find((option) => option.id === picked.id);
            return match && match !== picked
              ? { ...current, [field.name]: match }
              : current;
          });
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setDropdownErrors((current) => ({
              ...current,
              [field.name]:
                error instanceof Error
                  ? error.message
                  : `${field.label} options could not be loaded.`,
            }));
          }
        });
    }
    return () => {
      cancelled = true;
    };
    // Reload only when the set of dropdown target types changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.name, dropdownTypes]);

  /* Reference picks that disagree about the project (an Experiment whose
     sample and setup live in different projects) get a hint under the
     dropdown instead of a silent last-pick-wins. */
  function projectDisagreement(projectField: TemplateField): string | null {
    const sources: { label: string; projectId: string }[] = [];
    for (const field of template.fields) {
      if (field.type !== "entity" || field.name === projectField.name) {
        continue;
      }
      const rule = entityFieldRule(template, field);
      if (rule.autofill?.project_id !== projectField.name) {
        continue;
      }
      const picked = selectedEntities[field.name] as unknown as
        | Record<string, unknown>
        | null;
      const projectId = picked?.project_id;
      if (typeof projectId === "string" && projectId) {
        sources.push({ label: field.label, projectId });
      }
    }
    const distinct = new Set(sources.map((source) => source.projectId));
    if (distinct.size < 2) {
      return null;
    }
    const options = dropdownOptions[projectField.name] ?? [];
    const nameOf = (projectId: string): string =>
      optionLabel(
        options.find((option) => option.id === projectId) ?? projectRefStub(projectId),
      ) || projectId;
    return (
      sources
        .map((source) => `${source.label} is in ${nameOf(source.projectId)}`)
        .join("; ") + "."
    );
  }
  const [body, setBody] = useState(initialBody ?? "");
  const [copies, setCopies] = useState("1");
  const [autofillValues, setAutofillValues] = useState<Record<string, unknown>>(
    {},
  );
  // step_index suggestion plumbing: the request counter drops stale results
  // after a repick; the last suggested value distinguishes "still showing
  // our suggestion" (safe to replace) from a value the user typed (kept).
  const stepIndexRequestRef = useRef(0);
  const stepIndexSuggestionRef = useRef<string | null>(null);

  function suggestNextStepIndex(pickedId: string): void {
    const requestId = ++stepIndexRequestRef.current;
    void (async () => {
      try {
        const graph = await getLineageGraph(pickedId, {
          direction: "down",
          depth: 1,
          relations: ["refers_to"],
        });
        const indices = await Promise.all(
          graph.nodes
            .filter((node) => node.entity_type === "fab_step")
            .map((node) =>
              getEntity("fab_step", node.id).then((response) => {
                const value = (response.data as { step_index?: unknown })
                  .step_index;
                return typeof value === "number" ? value : 0;
              }),
            ),
        );
        if (requestId !== stepIndexRequestRef.current) {
          return;
        }
        const next = String(indices.length > 0 ? Math.max(...indices) + 1 : 1);
        setValues((current) => {
          const existing = current.step_index ?? "";
          if (existing !== "" && existing !== stepIndexSuggestionRef.current) {
            return current;
          }
          stepIndexSuggestionRef.current = next;
          return { ...current, step_index: next };
        });
      } catch {
        // Suggestion only; on any failure the field stays manual.
      }
    })();
  }

  // A prefilled reference (e.g. "+ Add step" from a wafer page) seeds state
  // without going through onPick, so ask for the step-index suggestion here
  // too — the deep link should land on a form that is ready to submit.
  useEffect(() => {
    for (const field of template.fields) {
      if (field.type !== "entity") {
        continue;
      }
      const picked = initialEntityRefs?.[field.name];
      if (picked && entityFieldRule(template, field).nextStepIndex) {
        suggestNextStepIndex(picked.id);
      }
    }
    // Mount only: later picks run the suggestion through onPick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [attachments, setAttachments] = useState<File[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<Entity | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [queuedOffline, setQueuedOffline] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [notifyTargets, setNotifyTargets] = useState<NotifyTarget[]>([]);
  const [notifyWarning, setNotifyWarning] = useState<string | null>(null);
  // Idempotency keys, one per copy, minted before the FIRST create attempt
  // and reused on every resubmit of the same logical records: if the server
  // committed but the response was lost, the retry (direct or via the
  // offline outbox) dedupes on source_key instead of creating a duplicate.
  // Cleared only once the server confirms every copy.
  const sourceKeysRef = useRef<string[]>([]);

  function claimSourceKeys(count: number): string[] {
    const keys = sourceKeysRef.current;
    while (keys.length < count) {
      keys.push(`web:${crypto.randomUUID()}`);
    }
    return keys.slice(0, count);
  }

  function autoPrintLabel(entity: Entity): void {
    if (!LABELABLE_ENTITY_TYPES.has(entity.entity_type)) {
      return;
    }
    void getPrinters()
      .then((printers) => {
        if (printers.length === 0) {
          return;
        }
        return printLabel(entity.id).then((result) =>
          onLabelPrinted?.(result.printer),
        );
      })
      .catch(() => {
        const message = "label failed — reprint from the entity page";
        if (onLabelError) {
          onLabelError(message);
        } else {
          setLabelError(message);
        }
      });
  }

  function resetForNextLogEntry(): void {
    setBody("");
    setResultsValues({});
    setValues((current) => {
      const next = { ...current };
      delete next.name;
      return next;
    });
    // The step just created counts now: suggest the one after it, replacing
    // the index that was submitted.
    for (const field of template.fields) {
      const picked = selectedEntities[field.name];
      if (picked && entityFieldRule(template, field).nextStepIndex) {
        stepIndexSuggestionRef.current = values.step_index ?? null;
        suggestNextStepIndex(picked.id);
      }
    }
  }

  function updateValue(
    fieldName: string,
    event: ChangeEvent<HTMLInputElement>,
  ): void {
    setValues((current) => ({ ...current, [fieldName]: event.target.value }));
  }

  function buildSubmission(): {
    fields: EntityInput;
    links: EntityLink[];
  } {
    const fields: EntityInput = {
      ...(template.defaults ?? {}),
      ...autofillValues,
    };
    const links: EntityLink[] = [...(extraLinks ?? [])];
    for (const field of template.fields) {
      if (field.type === "entity") {
        const rule = entityFieldRule(template, field);
        const selectedEntity = selectedEntities[field.name];
        if (field.required && !selectedEntity) {
          throw new Error(`Choose an entity for ${field.label}.`);
        }
        if (!selectedEntity) {
          continue;
        }
        if (!rule.targetEntityTypes.includes(selectedEntity.entity_type)) {
          throw new Error(
            `${field.label} must reference a ${describeTypes(rule.targetEntityTypes)}.`,
          );
        }
        if (rule.payloadField) {
          // The reference is a real column on the new entity, not an edge.
          fields[rule.payloadField] = selectedEntity.id;
        } else if (rule.outboundRelation) {
          links.push({
            relation: rule.outboundRelation,
            dst_id: selectedEntity.id,
          });
        }
        continue;
      }

      if (field.type === "results") {
        const map = resultsValues[field.name] ?? {};
        if (Object.keys(map).length > 0) {
          fields[field.name] = map;
        }
        continue;
      }
      const value = values[field.name]?.trim() ?? "";
      if (!value) {
        if (field.required) {
          throw new Error(`${field.label} is required.`);
        }
        continue;
      }
      fields[field.name] = convertFieldValue(field, value);
    }
    if (template.start_from && startFrom) {
      // The coldest stage follows the setup's own base temperature.
      const base = Number(values.base_temp_mk);
      fields.layout = setColdestStageTemp(
        startFrom.layout,
        Number.isFinite(base) && base > 0 ? base / 1000 : null,
      );
    }
    return { fields, links };
  }

  function addAttachments(added: Iterable<File>): void {
    // Copy now: Safari empties this FileList in place when the input is
    // cleared, which happens before React runs the updater.
    const files = Array.from(added);
    setAttachments((current) => {
      const next = [...current];
      for (const file of files) {
        const isDuplicate = next.some(
          (existing) =>
            existing.name === file.name && existing.size === file.size,
        );
        if (!isDuplicate) {
          next.push(file);
        }
      }
      return next;
    });
  }

  function removeAttachment(index: number): void {
    setAttachments((current) => current.filter((_, i) => i !== index));
  }

  async function uploadAttachments(entity: Entity): Promise<File[]> {
    const failed: File[] = [];
    for (const file of attachments) {
      try {
        await uploadArtifact(file, { linkEntityId: entity.id });
      } catch {
        failed.push(file);
      }
    }
    return failed;
  }

  const copyCount = Math.min(20, Math.max(1, Math.trunc(Number(copies)) || 1));

  // One create payload per requested copy. Links ride in each payload so the
  // record and its edges are one transaction: a bad link rolls back the
  // record server-side.
  function buildPayloads(): EntityInput[] {
    const submission = buildSubmission();
    const fields =
      template.entity_type === "note"
        ? {
            name: noteName(body, template.name),
            body,
            template: template.name,
            ...submission.fields,
          }
        : template.body
          ? { ...submission.fields, body }
          : submission.fields;
    const payload: EntityInput =
      submission.links.length > 0
        ? { ...fields, links: submission.links }
        : fields;
    if (copyCount === 1) {
      return [payload];
    }
    const baseName = typeof payload.name === "string" ? payload.name : null;
    return Array.from({ length: copyCount }, (_, index) =>
      baseName === null
        ? { ...payload }
        : {
            ...payload,
            name: `${baseName}-${String(index + 1).padStart(2, "0")}`,
          },
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitError(null);
    setLabelError(null);
    setNotifyWarning(null);

    const createdRecords: Entity[] = [];
    let payloads: EntityInput[] = [];
    try {
      setIsSubmitting(true);
      if (uploadTarget) {
        createdRecords.push(uploadTarget);
      } else {
        const sourceKeys = claimSourceKeys(copyCount);
        payloads = buildPayloads().map((payload, index) => ({
          ...payload,
          source_key: sourceKeys[index],
        }));
        for (const payload of payloads) {
          createdRecords.push(
            await createEntity(template.entity_type, payload),
          );
        }
        // Every copy is confirmed committed; the next submission is a new
        // logical record and gets fresh keys.
        sourceKeysRef.current = [];
      }

      const first = createdRecords[0];
      // Attachments only apply to single-record submissions; the dropzone is
      // replaced by a note when Copies > 1.
      if (createdRecords.length === 1) {
        const failedUploads = await uploadAttachments(first);
        if (failedUploads.length > 0) {
          setAttachments(failedUploads);
          setUploadTarget(first);
          setSubmitError(
            `${first.accession} was created, but ` +
              `${failedUploads.length} attachment${failedUploads.length === 1 ? "" : "s"} ` +
              "failed to upload. Retry without creating another record.",
          );
          return;
        }
        setAttachments([]);
      }
      setUploadTarget(null);
      setQueuedOffline(false);
      if (LOG_ENTITY_TYPES.has(template.entity_type)) {
        resetForNextLogEntry();
      }

      if (createdRecords.length > 1 && onBatchCreated) {
        onBatchCreated([...createdRecords]);
      } else {
        onCreated?.(first);
      }
      for (const created of createdRecords) {
        autoPrintLabel(created);
      }
      if (notifyTargets.length > 0) {
        // The records exist regardless: a notify failure warns, never fails.
        const personIds = notifyTargets.map((target) => target.id);
        let notifyFailures = 0;
        for (const created of createdRecords) {
          try {
            await postNotify({
              person_ids: personIds,
              entity_id: created.id,
            });
          } catch {
            notifyFailures += 1;
          }
        }
        if (notifyFailures > 0) {
          setNotifyWarning(
            "The record was created, but the notification could not be " +
              "queued — tell them yourself this time.",
          );
        } else {
          setNotifyTargets([]);
        }
      }
    } catch (error: unknown) {
      if (!uploadTarget && isNetworkFailure(error)) {
        // Offline in the cleanroom: queue the records that were not created
        // so the typed data survives; they sync on reconnect. Attachments
        // cannot be queued. The queued payloads keep their source_key, so a
        // replay of a create that actually reached the server dedupes.
        let queued = false;
        try {
          for (const payload of payloads.slice(createdRecords.length)) {
            enqueueCreate(template.entity_type, payload);
          }
          queued = true;
        } catch {
          // The outbox could not be persisted; the draft stays in the form.
        }
        if (queued) {
          setQueuedOffline(true);
          if (notifyTargets.length > 0) {
            // Queued creates replay without their notify targets — say so
            // instead of letting the sender assume the DM went out.
            setNotifyWarning(
              "Offline-queued records do not send notifications — " +
                "DM them yourself once the record syncs.",
            );
          }
          setSubmitError(
            attachments.length > 0 && copyCount === 1
              ? "Attachments cannot be queued offline — re-attach them from " +
                  "the record page once the record has synced."
              : null,
          );
          setAttachments([]);
        } else {
          setSubmitError(
            "You appear to be offline and the record could not be queued " +
              "for later sync. Your entries are kept — retry when the " +
              "connection returns.",
          );
        }
      } else {
        const message =
          error instanceof Error
            ? error.message
            : "The record could not be created.";
        setSubmitError(
          createdRecords.length > 0
            ? `Created ${createdRecords.length} of ${payloads.length} records — ${message}`
            : message,
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  const isLocked = isSubmitting || uploadTarget !== null;

  return (
    <form
      aria-label={`${template.name} form`}
      className="template-form"
      onSubmit={(event) => void submit(event)}
    >
      <div className="form-heading">
        <p className="eyebrow">{template.entity_type.replaceAll("_", " ")}</p>
        <h2>{template.name}</h2>
      </div>
      <div className="template-fields">
        {template.fields.map((field) => {
          if (field.type === "entity") {
            const rule = entityFieldRule(template, field);
            if (rule.picker === "dropdown") {
              return (
                <DropdownEntityPicker
                  allowNone={!field.required}
                  disabled={isLocked}
                  field={field}
                  hint={
                    rule === PROJECT_RULE ? projectDisagreement(field) : null
                  }
                  key={field.name}
                  loadError={dropdownErrors[field.name] ?? null}
                  onPick={(entity) => {
                    setExplicitFields((current) => new Set(current).add(field.name));
                    setSelectedEntities((current) => ({
                      ...current,
                      [field.name]: entity,
                    }));
                  }}
                  options={dropdownOptions[field.name] ?? null}
                  selectedId={selectedEntities[field.name]?.id ?? ""}
                />
              );
            }
            const startFromPicker =
              template.start_from?.field === field.name ? (
                <StartFromPicker
                  cloned={initialLayout}
                  disabled={isLocked}
                  key={`${field.name}-start-from`}
                  onChange={setStartFrom}
                  testbed={selectedEntities[field.name] ?? null}
                />
              ) : null;
            return (
              <Fragment key={field.name}>
              <RecentEntityPicker
                disabled={isLocked}
                field={field}
                initialSelection={initialEntityRefs?.[field.name] ?? null}
                onPick={(entity) => {
                  setSelectedEntities((current) => ({
                    ...current,
                    [field.name]: entity,
                  }));
                  if (rule.nextStepIndex && entity) {
                    suggestNextStepIndex(entity.id);
                  }
                  if (!entity || !rule.autofill) {
                    return;
                  }
                  const source = entity as unknown as Record<string, unknown>;
                  for (const [from, to] of Object.entries(rule.autofill)) {
                    const value = source[from];
                    if (value === null || value === undefined || value === "") {
                      continue;
                    }
                    const destination = template.fields.find((f) => f.name === to);
                    if (destination?.type === "entity") {
                      // Inherit into a reference field (the project
                      // dropdown) unless the user already chose one.
                      if (explicitFields.has(to) || typeof value !== "string") {
                        continue;
                      }
                      const options = dropdownOptions[to] ?? [];
                      setSelectedEntities((current) => ({
                        ...current,
                        [to]:
                          options.find((option) => option.id === value) ??
                          projectRefStub(value),
                      }));
                    } else if (destination) {
                      setValues((current) => ({
                        ...current,
                        [to]: String(value),
                      }));
                    } else {
                      setAutofillValues((current) => ({
                        ...current,
                        [to]: value,
                      }));
                    }
                  }
                }}
                scannable={rule.scan !== false}
                targetEntityTypes={rule.targetEntityTypes}
                where={rule.where}
              />
              {startFromPicker}
              </Fragment>
            );
          }
          if (field.type === "results") {
            return (
              <div className="template-field template-field--wide" key={field.name}>
                <span className="attachment-label">{field.label}</span>
                <ResultsFieldEditor
                  disabled={isLocked}
                  onChange={(next) =>
                    setResultsValues((current) => ({ ...current, [field.name]: next }))
                  }
                  value={resultsValues[field.name] ?? {}}
                />
              </div>
            );
          }
          if (field.type === "select") {
            return (
              <div className="template-field" key={field.name}>
                <label htmlFor={`template-field-${field.name}`}>
                  {field.label}
                  {field.required ? <span aria-hidden="true"> *</span> : null}
                </label>
                <select
                  id={`template-field-${field.name}`}
                  disabled={isLocked}
                  onChange={(event) => {
                    const next = event.target.value;
                    setValues((current) => ({ ...current, [field.name]: next }));
                  }}
                  required={field.required}
                  value={values[field.name] ?? ""}
                >
                  {!field.required || !values[field.name] ? (
                    <option value="">{field.required ? "Select…" : "None"}</option>
                  ) : null}
                  {(field.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </div>
            );
          }
          return (
            <div className="template-field" key={field.name}>
              <label htmlFor={`template-field-${field.name}`}>
                {field.label}
                {field.unit ? ` (${field.unit})` : ""}
                {field.required ? <span aria-hidden="true"> *</span> : null}
              </label>
              <input
                id={`template-field-${field.name}`}
                inputMode={field.type === "number" ? "decimal" : undefined}
                disabled={isLocked}
                onChange={(event) => updateValue(field.name, event)}
                required={field.required}
                step={field.type === "number" ? "any" : undefined}
                type={inputType(field)}
                value={values[field.name] ?? ""}
              />
            </div>
          );
        })}
        {template.body ? (
          <div className="template-field template-field--wide">
            <label htmlFor="template-body">Markdown note</label>
            <MarkdownEditor
              id="template-body"
              disabled={isSubmitting}
              onChange={setBody}
              placeholder="Record observations, decisions, and next steps…"
              rows={10}
              value={body}
            />
          </div>
        ) : null}
        {(template.body || template.attachments) && copyCount > 1 ? (
          <div className="template-field template-field--wide">
            <span className="attachment-label">Attachments</span>
            <p className="attachment-batch-note">
              Attachments are only uploaded for single records — set Copies to 1
              to attach files.
            </p>
          </div>
        ) : null}
        {(template.body || template.attachments) && copyCount === 1 ? (
          <div className="template-field template-field--wide">
            <span className="attachment-label" id="attachment-heading">
              Attachments
            </span>
            <div
              aria-labelledby="attachment-heading"
              className={
                isDragActive
                  ? "attachment-dropzone attachment-dropzone--active"
                  : "attachment-dropzone"
              }
              onDragLeave={() => setIsDragActive(false)}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragActive(true);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragActive(false);
                addAttachments(event.dataTransfer.files);
              }}
            >
              <p>Drop files here, or</p>
              <label className="attachment-browse">
                browse
                <input
                  aria-label="Add attachments"
                  disabled={isSubmitting}
                  multiple
                  onChange={(event) => {
                    if (event.target.files) {
                      addAttachments(event.target.files);
                      event.target.value = "";
                    }
                  }}
                  type="file"
                />
              </label>
              <div className="attachment-camera-row">
                <label className="attachment-camera">
                  📷 Take a photo
                  <input
                    accept="image/*"
                    aria-label="Take a photo"
                    capture="environment"
                    disabled={isSubmitting}
                    onChange={(event) => {
                      if (event.target.files) {
                        addAttachments(event.target.files);
                        event.target.value = "";
                      }
                    }}
                    type="file"
                  />
                </label>
              </div>
            </div>
            {attachments.length > 0 ? (
              <ul className="attachment-list">
                {attachments.map((file, index) => (
                  <li key={`${file.name}-${file.size}`}>
                    <span className="attachment-name">{file.name}</span>
                    <span className="attachment-size">
                      {formatFileSize(file.size)}
                    </span>
                    <button
                      aria-label={`Remove ${file.name}`}
                      className="text-button"
                      disabled={isSubmitting}
                      onClick={() => removeAttachment(index)}
                      type="button"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
      {template.notify ? (
        <NotifyPicker
          disabled={isLocked}
          onChange={setNotifyTargets}
          selected={notifyTargets}
        />
      ) : null}
      {notifyWarning ? (
        <p aria-live="polite" className="form-message form-message--error">
          {notifyWarning}
        </p>
      ) : null}
      {queuedOffline ? (
        <p aria-live="polite" className="form-message form-message--success">
          You appear to be offline — the record is queued and will sync
          automatically when the connection returns.
        </p>
      ) : null}
      {submitError ? (
        <p aria-live="polite" className="form-message form-message--error">
          {submitError}
        </p>
      ) : null}
      {labelError ? (
        <p aria-live="polite" className="form-message form-message--error">
          {labelError}
        </p>
      ) : null}
      <div className="form-footer">
        {template.batch ? (
          <div className="template-field copies-field">
            <label htmlFor="template-copies">Copies</label>
            <input
              disabled={isLocked}
              id="template-copies"
              inputMode="numeric"
              max={20}
              min={1}
              onChange={(event) => setCopies(event.target.value)}
              step={1}
              type="number"
              value={copies}
            />
          </div>
        ) : null}
        <button
          className="primary-button"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting
            ? uploadTarget
              ? "Retrying uploads…"
              : "Creating…"
            : uploadTarget
              ? "Retry attachments"
              : copyCount > 1
                ? `Create ${copyCount} records`
                : `Create ${template.name.toLowerCase()}`}
        </button>
      </div>
    </form>
  );
}
