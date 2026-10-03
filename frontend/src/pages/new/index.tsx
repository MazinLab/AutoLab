import { type ReactElement, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import {
  ACTOR_STORAGE_KEY,
  getEntity,
  getLineageGraph,
  getRegistry,
  getTemplates,
  type Entity,
  type EntityLink,
  type EntityTemplate,
  type Layout,
  type LineageGraph,
  type SearchResult,
  type ResultValue,
} from "../../api/client";
import { ACCESSION_PREFIXES } from "../../accessionPrefixes";
import { PERSON_CREATED_EVENT } from "../../components/ActorPicker";
import {
  CLONE_EDGE_RELATIONS,
  TemplateForm,
  cloneEntityRefs,
  entityRefsForTarget,
  inheritedProjectRefs,
} from "../../components/TemplateForm";

const TEMPLATE_GROUPS = [
  { key: "projects", title: "Projects" },
  { key: "fab", title: "Fab" },
  { key: "testing", title: "Testing" },
  { key: "other", title: "Other" },
];

function toDatetimeLocal(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  const pad = (part: number): string => String(part).padStart(2, "0");
  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-` +
    `${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  );
}

// Flexible fields overflow into `extra` server-side, so a clone must read
// both levels. A populated top-level column wins; empty top-level values do
// not shadow a real extra value of the same name.
function sourceFieldValues(source: Entity): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...source.extra };
  for (const [key, value] of Object.entries(source)) {
    if (value !== null && value !== undefined && value !== "") {
      merged[key] = value;
    }
  }
  return merged;
}

// Prefer the template whose stamped defaults all match the source record
// (e.g. instrument category picks Experimental vs Fab Equipment); otherwise
// any template of the right entity type.
function templateForSource(
  templates: EntityTemplate[],
  source: Entity,
): EntityTemplate | undefined {
  const candidates = templates.filter(
    (template) => template.entity_type === source.entity_type,
  );
  const fields = sourceFieldValues(source);
  return (
    candidates.find((template) =>
      Object.entries(template.defaults ?? {}).every(
        ([key, value]) => fields[key] === value,
      ),
    ) ?? candidates[0]
  );
}

// Starting form values cloned from a source record: template fields whose
// names match columns on the source (or keys in its `extra`) carry over
// (entity references are edges, not columns, so they are not prefillable
// here). The name gets a " (copy)" suffix so sibling records are
// distinguishable until renamed.
function prefillFormValues(
  template: EntityTemplate,
  source: Entity,
): Record<string, string> {
  const values: Record<string, string> = {};
  const fields = sourceFieldValues(source);
  for (const field of template.fields) {
    // Entity references are edges and results are an object column; neither
    // fits a string map (see initialEntityRefs / initialResults).
    if (field.type === "entity" || field.type === "results") {
      continue;
    }
    const raw = fields[field.name];
    if (raw === null || raw === undefined || raw === "") {
      continue;
    }
    if (field.type === "datetime") {
      const local = toDatetimeLocal(String(raw));
      if (local) {
        values[field.name] = local;
      }
      continue;
    }
    values[field.name] =
      field.name === "name" ? `${String(raw)} (copy)` : String(raw);
  }
  return values;
}

export function NewEntityPage(): ReactElement {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const requestedTemplate = searchParams.get("template");
  const selectAsActor = searchParams.get("actor") === "1";
  const fromParam = searchParams.get("from");
  const supersedeParam = searchParams.get("supersede");
  const prefillId = fromParam ?? supersedeParam;
  // "?for=" starts a record that points AT another record (a fab step for
  // this wafer), as opposed to "?from=" which copies one.
  const forParam = searchParams.get("for");
  // "?project=" preselects the project dropdown as a deliberate choice, so
  // reference picks on the form never override it.
  const projectParam = searchParams.get("project");
  const [projectRef, setProjectRef] = useState<SearchResult | null>(null);
  const [isProjectResolved, setIsProjectResolved] = useState(false);
  const [templates, setTemplates] = useState<EntityTemplate[] | null>(null);
  const [selectedTemplate, setSelectedTemplate] =
    useState<EntityTemplate | null>(null);
  const [createdRecords, setCreatedRecords] = useState<Entity[] | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);
  const [prefillEntity, setPrefillEntity] = useState<Entity | null>(null);
  const [targetEntity, setTargetEntity] = useState<Entity | null>(null);
  const [isTargetResolved, setIsTargetResolved] = useState(false);
  const [prefillGraph, setPrefillGraph] = useState<LineageGraph | null>(null);
  const [prefillError, setPrefillError] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  // Records that auto-print say so; otherwise people print a second label.
  const [labelPrinter, setLabelPrinter] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getTemplates()
      .then((loadedTemplates) => {
        if (!cancelled) {
          setTemplates(loadedTemplates);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Templates could not be loaded.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Deep links (e.g. the actor picker's "+ Add a person…") preselect a
  // template by name.
  useEffect(() => {
    if (!templates || !requestedTemplate) {
      return;
    }
    const match = templates.find(
      (template) => template.name === requestedTemplate,
    );
    if (match) {
      setSelectedTemplate((current) => current ?? match);
    }
  }, [templates, requestedTemplate]);

  // Clone (?from=) and supersede (?supersede=) load the source record. The
  // registry lookup resolves the id to a type so the typed row can be read.
  useEffect(() => {
    if (!prefillId) {
      return;
    }
    let cancelled = false;
    void getRegistry(prefillId)
      .then((registry) => getEntity(registry.entity_type, prefillId))
      .then((response) => {
        if (!cancelled) {
          setPrefillEntity(response.data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPrefillError(
            error instanceof Error
              ? error.message
              : "The source record could not be loaded.",
          );
        }
      });
    // Entity references live on edges, not columns (Autolab-8oc): fetch the
    // source's direct outbound links so clone can re-pick them. Best-effort —
    // a failure only loses the reference prefill, not the clone.
    void getLineageGraph(prefillId, {
      direction: "up",
      depth: 1,
      relations: CLONE_EDGE_RELATIONS,
      hydrate: true,
    })
      .then((graph) => {
        if (!cancelled) {
          setPrefillGraph(graph);
        }
      })
      .catch(() => {
        // Losing the reference prefill must not block the clone: settle
        // with an empty graph so the form still renders.
        if (!cancelled) {
          setPrefillGraph({ nodes: [], edges: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [prefillId]);

  // "?for=" only needs the target record itself; the reference maps onto
  // whichever entity field accepts its type.
  useEffect(() => {
    if (!forParam) {
      return;
    }
    let cancelled = false;
    void getRegistry(forParam)
      .then((registry) => getEntity(registry.entity_type, forParam))
      .then((response) => {
        if (!cancelled) {
          setTargetEntity(response.data);
        }
      })
      .catch(() => {
        // Best effort: without the target the form simply starts unpicked.
        if (!cancelled) {
          setTargetEntity(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsTargetResolved(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [forParam]);

  useEffect(() => {
    if (!projectParam) {
      return;
    }
    let cancelled = false;
    void getEntity("project", projectParam)
      .then((response) => {
        if (!cancelled) {
          setProjectRef(response.data);
        }
      })
      .catch(() => {
        // Best effort: an unknown project just leaves the dropdown empty.
        if (!cancelled) {
          setProjectRef(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsProjectResolved(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectParam]);

  // Once the source record is known, preselect its template: note-backed
  // records match on their template column, everything else on entity type.
  useEffect(() => {
    if (!templates || !prefillEntity) {
      return;
    }
    const byTemplateName =
      typeof prefillEntity.template === "string"
        ? templates.find((template) => template.name === prefillEntity.template)
        : undefined;
    const match = byTemplateName ?? templateForSource(templates, prefillEntity);
    if (match) {
      setSelectedTemplate((current) => current ?? match);
    }
  }, [templates, prefillEntity]);

  function handleBatchCreated(entities: Entity[]): void {
    const first = entities[0];
    // A setup's real work starts in the designer on its page, so go there
    // instead of the success card ("Create another" matters for wafers
    // and devices, not for cooldowns).
    if (entities.length === 1 && first.entity_type === "experiment_setup") {
      navigate(`/entity/${encodeURIComponent(first.id)}`);
      return;
    }
    setCreatedRecords(entities);
    if (first.entity_type === "person") {
      if (selectAsActor) {
        window.localStorage.setItem(ACTOR_STORAGE_KEY, first.id);
      }
      window.dispatchEvent(
        new CustomEvent(PERSON_CREATED_EVENT, {
          detail: { id: first.id, select: selectAsActor },
        }),
      );
    }
  }

  function handleCreated(entity: Entity): void {
    handleBatchCreated([entity]);
  }

  function chooseTemplate(template: EntityTemplate): void {
    setSelectedTemplate(template);
    setCreatedRecords(null);
    setLabelError(null);
    setLabelPrinter(null);
  }

  // "Create another" keeps the form state (all fields and entity picks) so a
  // sibling record only needs a name tweak; "Start blank" remounts the form.
  function createAnother(): void {
    setCreatedRecords(null);
    setLabelError(null);
    setLabelPrinter(null);
  }

  function startBlank(): void {
    setCreatedRecords(null);
    setLabelError(null);
    setLabelPrinter(null);
    setFormEpoch((epoch) => epoch + 1);
  }

  if (loadError) {
    return (
      <section className="page-panel">
        <p className="eyebrow">Create</p>
        <h1>New record</h1>
        <p className="form-message form-message--error">{loadError}</p>
      </section>
    );
  }

  const prefillPending =
    prefillId !== null && (!prefillEntity || !prefillGraph) && !prefillError;
  // The form seeds its picks once, at mount, so it must not mount before the
  // "?for=" target has resolved or the prefilled reference is dropped.
  const targetPending =
    (forParam !== null && !isTargetResolved) ||
    (projectParam !== null && !isProjectResolved);
  const initialValues =
    selectedTemplate && prefillEntity
      ? prefillFormValues(selectedTemplate, prefillEntity)
      : undefined;
  const projectRefs =
    selectedTemplate && projectRef
      ? Object.fromEntries(
          selectedTemplate.fields
            .filter((field) => field.type === "entity" && field.name === "project")
            .map((field) => [field.name, projectRef]),
        )
      : {};
  const sourceRefs =
    selectedTemplate && prefillEntity && prefillGraph
      ? {
          ...inheritedProjectRefs(selectedTemplate, prefillEntity),
          ...cloneEntityRefs(selectedTemplate, prefillGraph, prefillEntity.id),
        }
      : selectedTemplate && targetEntity
        ? entityRefsForTarget(selectedTemplate, targetEntity)
        : {};
  const mergedRefs = { ...sourceRefs, ...projectRefs };
  const initialEntityRefs =
    Object.keys(mergedRefs).length > 0 ? mergedRefs : undefined;
  const initialExplicitFields = Object.keys(projectRefs);
  const initialBody =
    selectedTemplate?.body &&
    prefillEntity &&
    typeof prefillEntity.body === "string"
      ? prefillEntity.body
      : undefined;
  const extraLinks: EntityLink[] | undefined =
    supersedeParam && prefillEntity
      ? [{ relation: "supersedes", dst_id: prefillEntity.id }]
      : undefined;
  // Object valued columns a clone carries over (scalar prefill skips them).
  const initialLayout =
    selectedTemplate?.start_from &&
    prefillEntity &&
    prefillEntity.layout &&
    typeof prefillEntity.layout === "object" &&
    Array.isArray((prefillEntity.layout as Layout).stages) &&
    (prefillEntity.layout as Layout).stages.length > 0
      ? { layout: prefillEntity.layout as Layout, sourceAccession: prefillEntity.accession }
      : null;
  const initialResults =
    prefillEntity &&
    selectedTemplate?.fields.some((field) => field.type === "results") &&
    prefillEntity.results &&
    typeof prefillEntity.results === "object"
      ? (prefillEntity.results as Record<string, ResultValue>)
      : undefined;

  return (
    <section className="page-panel capture-page">
      <p className="eyebrow">Create</p>
      <h1>New record</h1>
      <p className="lede">
        Start with a shared template so the important context is captured at the
        bench.
      </p>

      {!templates ? (
        <p className="loading-message">Loading templates…</p>
      ) : null}
      {prefillPending || targetPending ? (
        <p className="loading-message">Loading source record…</p>
      ) : null}
      {prefillError ? (
        <p className="form-message form-message--error">{prefillError}</p>
      ) : null}

      {templates && !selectedTemplate && !prefillPending && !targetPending ? (
        <div className="template-groups" aria-label="Record templates">
          {TEMPLATE_GROUPS.map((group) => {
            const members = templates.filter(
              (template) => (template.group ?? "other") === group.key,
            );
            if (members.length === 0) {
              return null;
            }
            return (
              <section
                aria-labelledby={`template-group-${group.key}`}
                className={`template-group template-group--${group.key}`}
                key={group.key}
              >
                <h2 id={`template-group-${group.key}`}>{group.title}</h2>
                <div className="template-chooser">
                  {members.map((template) => (
                    <button
                      aria-label={template.name}
                      className="template-choice"
                      key={template.name}
                      onClick={() => chooseTemplate(template)}
                      type="button"
                    >
                      <span>{template.name}</span>
                      <small
                        aria-hidden="true"
                        className="template-prefix"
                        title={template.entity_type.replaceAll("_", " ")}
                      >
                        {ACCESSION_PREFIXES[template.entity_type] ?? "?"}-
                      </small>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : null}

      {selectedTemplate && !targetPending ? (
        <div className="selected-template">
          <button
            className="text-button"
            onClick={() => setSelectedTemplate(null)}
            type="button"
          >
            ← All templates
          </button>
          {supersedeParam && prefillEntity ? (
            <p className="supersede-banner">
              Will supersede {prefillEntity.accession}
            </p>
          ) : null}
          {createdRecords ? (
            <div aria-live="polite" className="success-card">
              <p>
                {createdRecords.length === 1
                  ? `Created ${createdRecords[0].accession}`
                  : `Created ${createdRecords.length} records`}
              </p>
              {createdRecords.length > 1 ? (
                <p className="batch-accessions">
                  {createdRecords
                    .map((created) => created.accession)
                    .join(", ")}
                </p>
              ) : null}
              {labelPrinter ? (
                <p>
                  {createdRecords.length === 1 ? "Label" : "Labels"} sent to{" "}
                  {labelPrinter}.
                </p>
              ) : null}
              {labelError ? (
                <div className="form-message form-message--error">
                  {labelError}
                </div>
              ) : null}
              <Link to={`/entity/${encodeURIComponent(createdRecords[0].id)}`}>
                Open record
              </Link>
              <button
                className="secondary-button"
                onClick={createAnother}
                type="button"
              >
                Create another
              </button>
              <button
                className="text-button"
                onClick={startBlank}
                type="button"
              >
                Start blank
              </button>
            </div>
          ) : null}
          {/* The form stays mounted behind the success card so "Create
              another" can resume with the previous values intact. */}
          <div hidden={createdRecords !== null}>
            <TemplateForm
              extraLinks={extraLinks}
              initialBody={initialBody}
              initialEntityRefs={initialEntityRefs}
              initialExplicitFields={initialExplicitFields}
              initialLayout={initialLayout}
              initialResults={initialResults}
              initialValues={initialValues}
              key={`${selectedTemplate.name}-${formEpoch}`}
              onBatchCreated={handleBatchCreated}
              onCreated={handleCreated}
              onLabelError={setLabelError}
              onLabelPrinted={setLabelPrinter}
              template={selectedTemplate}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
