import { type ReactElement, useEffect, useMemo, useState } from "react";

import {
  ApiError,
  getSchema,
  patchEntity,
  type Entity,
  type EntityPatch,
  type SearchResult,
} from "../../api/client";
import { MarkdownEditor } from "../../components/MarkdownEditor";
import {
  DropdownEntityPicker,
  loadDropdownOptions,
} from "../../components/TemplateForm";

interface EntityEditorProps {
  entity: Entity;
  etag: string | null;
  onCancel: () => void;
  onSaved: (entity: Entity, etag: string | null) => void;
}

type FieldKind = "text" | "textarea" | "number" | "datetime" | "markdown";

interface EditableField {
  name: string;
  label: string;
  kind: FieldKind;
}

// Registry identity is immutable by invariant; artifact integrity fields are
// corrected through supersedes, never edited in place.
const NEVER_EDITABLE = new Set([
  "id",
  "extra",
  "accession",
  "entity_type",
  "source_key",
  "version",
  "created_at",
  "updated_at",
  "created_by_id",
]);
const ARTIFACT_INTEGRITY_FIELDS = new Set([
  "uri",
  "checksum_sha256",
  "size_bytes",
]);

// Reference columns the schema-driven editor cannot derive (UUID fields are
// skipped by fieldKind): each gets an explicit dropdown control. "None" is
// offered unless the form treats the reference as required for this type.
interface ReferenceField {
  name: "project_id" | "lead_id";
  label: string;
  targetType: "project" | "person";
}

const REFERENCE_FIELDS: ReferenceField[] = [
  { name: "project_id", label: "Project", targetType: "project" },
  { name: "lead_id", label: "Lead", targetType: "person" },
];

// Mirrors the templates' required project fields (spec 2026-09-09).
export function isProjectRequired(entity: Entity): boolean {
  switch (entity.entity_type) {
    case "wafer":
    case "device":
    case "experiment_setup":
    case "analysis_run":
      return true;
    case "note":
      return entity.template === "Experiment";
    default:
      return false;
  }
}

function fieldLabel(name: string, property: Record<string, unknown>): string {
  const title = property.title;
  return typeof title === "string" && title
    ? title
    : name.replaceAll("_", " ");
}

function fieldKind(
  name: string,
  property: Record<string, unknown>,
): FieldKind | null {
  if (name === "body") {
    return "markdown";
  }
  if (name === "description") {
    return "textarea";
  }
  const variants: Record<string, unknown>[] = Array.isArray(property.anyOf)
    ? (property.anyOf as Record<string, unknown>[])
    : [property];
  for (const variant of variants) {
    if (variant.type === "string" && variant.format === "date-time") {
      return "datetime";
    }
    if (variant.type === "number" || variant.type === "integer") {
      return "number";
    }
    if (variant.type === "string" && !variant.format) {
      return "text";
    }
  }
  return null;
}

function toDatetimeLocal(value: unknown): string {
  if (typeof value !== "string" || !value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  const pad = (part: number) => String(part).padStart(2, "0");
  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-` +
    `${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  );
}

function initialValue(entity: Entity, field: EditableField): string {
  const value = entity[field.name];
  if (field.kind === "datetime") {
    return toDatetimeLocal(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function convertValue(field: EditableField, value: string): unknown {
  const trimmed = value.trim();
  if (field.kind === "datetime") {
    if (trimmed === "") {
      return null;
    }
    const datetimeValue = new Date(trimmed);
    if (Number.isNaN(datetimeValue.getTime())) {
      throw new Error(`${field.label} must be a valid date and time.`);
    }
    return datetimeValue.toISOString();
  }
  return value;
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

export function editableFields(
  entityType: string,
  properties: Record<string, unknown>,
): EditableField[] {
  const fields: EditableField[] = [];
  for (const [name, rawProperty] of Object.entries(properties)) {
    if (NEVER_EDITABLE.has(name)) {
      continue;
    }
    if (entityType === "artifact" && ARTIFACT_INTEGRITY_FIELDS.has(name)) {
      continue;
    }
    const property = rawProperty as Record<string, unknown>;
    const kind = fieldKind(name, property);
    if (kind) {
      fields.push({ name, label: fieldLabel(name, property), kind });
    }
  }
  return fields;
}

export function EntityEditor({
  entity,
  etag,
  onCancel,
  onSaved,
}: EntityEditorProps): ReactElement {
  const [fields, setFields] = useState<EditableField[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [referenceFields, setReferenceFields] = useState<ReferenceField[]>([]);
  const [referenceValues, setReferenceValues] = useState<
    Record<string, string>
  >({});
  const [referenceOptions, setReferenceOptions] = useState<
    Record<string, SearchResult[] | null>
  >({});
  const [referenceErrors, setReferenceErrors] = useState<
    Record<string, string>
  >({});
  const [extraValues, setExtraValues] = useState<
    Record<string, string | boolean>
  >({});
  const [newExtraKey, setNewExtraKey] = useState("");
  const [newExtraValue, setNewExtraValue] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const scalarExtra = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(entity.extra).filter(([, value]) => isScalar(value)),
      ),
    [entity.extra],
  );

  useEffect(() => {
    let cancelled = false;
    getSchema()
      .then((schema) => {
        if (cancelled) {
          return;
        }
        const definition = schema.entity_types[entity.entity_type];
        const properties =
          definition && typeof definition.properties === "object"
            ? (definition.properties as Record<string, unknown>)
            : {};
        const derived = editableFields(entity.entity_type, properties);
        setFields(derived);
        const references = REFERENCE_FIELDS.filter(
          (field) => field.name in properties,
        );
        setReferenceFields(references);
        setReferenceValues(
          Object.fromEntries(
            references.map((field) => {
              const value = entity[field.name];
              return [field.name, typeof value === "string" ? value : ""];
            }),
          ),
        );
        for (const field of references) {
          loadDropdownOptions(field.targetType)
            .then((options) => {
              if (!cancelled) {
                setReferenceOptions((current) => ({
                  ...current,
                  [field.name]: options,
                }));
              }
            })
            .catch((loadError: unknown) => {
              if (!cancelled) {
                setReferenceErrors((current) => ({
                  ...current,
                  [field.name]:
                    loadError instanceof Error
                      ? loadError.message
                      : `${field.label} options could not be loaded.`,
                }));
              }
            });
        }
        setValues(
          Object.fromEntries(
            derived.map((field) => [field.name, initialValue(entity, field)]),
          ),
        );
        setExtraValues(
          Object.fromEntries(
            Object.entries(scalarExtra).map(([key, value]) => [
              key,
              typeof value === "boolean" ? value : String(value),
            ]),
          ),
        );
      })
      .catch((schemaError: unknown) => {
        if (!cancelled) {
          setError(
            schemaError instanceof Error
              ? schemaError.message
              : "The editing schema could not be loaded.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [entity, scalarExtra]);

  function clearFieldError(name: string): void {
    setFieldErrors((current) => {
      if (!(name in current)) {
        return current;
      }
      const rest = { ...current };
      delete rest[name];
      return rest;
    });
  }

  function buildPatch(): { patch: EntityPatch; errors: Record<string, string> } {
    const patch: EntityPatch = {};
    const errors: Record<string, string> = {};
    for (const field of fields ?? []) {
      const current = values[field.name] ?? "";
      if (current === initialValue(entity, field)) {
        continue;
      }
      if (field.kind === "number") {
        const trimmed = current.trim();
        if (trimmed === "") {
          patch[field.name] = null;
          continue;
        }
        const numberValue = Number(trimmed);
        if (!Number.isFinite(numberValue)) {
          errors[field.name] = `${field.label} must be a number.`;
          continue;
        }
        patch[field.name] = numberValue;
        continue;
      }
      patch[field.name] = convertValue(field, current);
    }
    for (const field of referenceFields) {
      const original = entity[field.name];
      const originalId = typeof original === "string" ? original : "";
      const current = referenceValues[field.name] ?? "";
      if (current === originalId) {
        continue;
      }
      if (
        current === "" &&
        field.name === "project_id" &&
        isProjectRequired(entity)
      ) {
        errors[field.name] = "This record must belong to a project.";
        continue;
      }
      patch[field.name] = current || null;
    }
    for (const [key, value] of Object.entries(extraValues)) {
      const original = scalarExtra[key];
      if (typeof value === "boolean") {
        if (value !== original) {
          patch[key] = value;
        }
        continue;
      }
      if (value === String(original)) {
        continue;
      }
      if (typeof original === "number") {
        const numberValue = Number(value.trim());
        if (value.trim() === "" || !Number.isFinite(numberValue)) {
          errors[`extra:${key}`] =
            `${key.replaceAll("_", " ")} must be a number.`;
          continue;
        }
        patch[key] = numberValue;
        continue;
      }
      patch[key] = value;
    }
    const addedKey = newExtraKey.trim();
    if (addedKey) {
      if (addedKey in entity.extra || (fields ?? []).some((f) => f.name === addedKey)) {
        throw new Error(`Field ${addedKey} already exists.`);
      }
      patch[addedKey] = newExtraValue;
    }
    return { patch, errors };
  }

  async function save(): Promise<void> {
    setError(null);
    try {
      const { patch, errors } = buildPatch();
      setFieldErrors(errors);
      if (Object.keys(errors).length > 0) {
        return;
      }
      if (Object.keys(patch).length === 0) {
        onCancel();
        return;
      }
      setIsSaving(true);
      const result = await patchEntity(
        entity.entity_type,
        entity.id,
        patch,
        etag ?? undefined,
      );
      onSaved(result.data, result.etag);
    } catch (saveError: unknown) {
      if (saveError instanceof ApiError && saveError.status === 412) {
        setError(
          "This record changed since you loaded it. Reload the page, then re-apply your edit.",
        );
      } else {
        setError(
          saveError instanceof Error
            ? saveError.message
            : "The record could not be saved.",
        );
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section aria-label="Edit record" className="entity-section entity-editor">
      <p className="eyebrow">Editing</p>
      <h2>Edit {entity.accession}</h2>
      <p className="entity-editor-hint">
        Every change is kept in the record's history; the page shows the
        latest version.
      </p>
      {fields === null && !error ? (
        <p className="loading-message">Loading fields…</p>
      ) : null}
      {fields ? (
        <form
          className="template-fields entity-editor-fields"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {fields.map((field) => (
            <div
              className={
                field.kind === "markdown" || field.kind === "textarea"
                  ? "template-field template-field--wide"
                  : "template-field"
              }
              key={field.name}
            >
              <label htmlFor={`edit-${field.name}`}>{field.label}</label>
              {field.kind === "markdown" ? (
                <MarkdownEditor
                  id={`edit-${field.name}`}
                  disabled={isSaving}
                  onChange={(next) =>
                    setValues((current) => ({ ...current, [field.name]: next }))
                  }
                  value={values[field.name] ?? ""}
                />
              ) : field.kind === "textarea" ? (
                <textarea
                  id={`edit-${field.name}`}
                  disabled={isSaving}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.name]: event.target.value,
                    }))
                  }
                  rows={3}
                  value={values[field.name] ?? ""}
                />
              ) : (
                <input
                  id={`edit-${field.name}`}
                  aria-invalid={fieldErrors[field.name] ? true : undefined}
                  disabled={isSaving}
                  inputMode={field.kind === "number" ? "decimal" : undefined}
                  onChange={(event) => {
                    const next = event.target.value;
                    setValues((current) => ({
                      ...current,
                      [field.name]: next,
                    }));
                    clearFieldError(field.name);
                  }}
                  type={field.kind === "datetime" ? "datetime-local" : "text"}
                  value={values[field.name] ?? ""}
                />
              )}
              {fieldErrors[field.name] ? (
                <p
                  aria-live="polite"
                  className="form-message form-message--error"
                >
                  {fieldErrors[field.name]}
                </p>
              ) : null}
            </div>
          ))}

          {referenceFields.map((field) => (
            <div className="entity-editor-reference" key={field.name}>
              <DropdownEntityPicker
                allowNone={
                  !(field.name === "project_id" && isProjectRequired(entity))
                }
                disabled={isSaving}
                field={{
                  name: field.name,
                  label: field.label,
                  type: "entity",
                  required:
                    field.name === "project_id" && isProjectRequired(entity),
                }}
                idOverride={`edit-${field.name}`}
                loadError={referenceErrors[field.name] ?? null}
                onPick={(picked) => {
                  setReferenceValues((current) => ({
                    ...current,
                    [field.name]: picked?.id ?? "",
                  }));
                  clearFieldError(field.name);
                }}
                options={referenceOptions[field.name] ?? null}
                selectedId={referenceValues[field.name] ?? ""}
              />
              {fieldErrors[field.name] ? (
                <p
                  aria-live="polite"
                  className="form-message form-message--error"
                >
                  {fieldErrors[field.name]}
                </p>
              ) : null}
            </div>
          ))}

          {Object.keys(extraValues).length > 0 ? (
            <div className="template-field template-field--wide">
              <span className="attachment-label">Extra fields</span>
              <div className="entity-editor-extra">
                {Object.entries(extraValues).map(([key, extraValue]) => (
                  <div className="template-field" key={key}>
                    <label htmlFor={`edit-extra-${key}`}>
                      {key.replaceAll("_", " ")}
                    </label>
                    {typeof extraValue === "boolean" ? (
                      <select
                        id={`edit-extra-${key}`}
                        disabled={isSaving}
                        onChange={(event) =>
                          setExtraValues((current) => ({
                            ...current,
                            [key]: event.target.value === "true",
                          }))
                        }
                        value={extraValue ? "true" : "false"}
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : (
                      <input
                        id={`edit-extra-${key}`}
                        aria-invalid={
                          fieldErrors[`extra:${key}`] ? true : undefined
                        }
                        disabled={isSaving}
                        onChange={(event) => {
                          const next = event.target.value;
                          setExtraValues((current) => ({
                            ...current,
                            [key]: next,
                          }));
                          clearFieldError(`extra:${key}`);
                        }}
                        type="text"
                        value={extraValue}
                      />
                    )}
                    {fieldErrors[`extra:${key}`] ? (
                      <p
                        aria-live="polite"
                        className="form-message form-message--error"
                      >
                        {fieldErrors[`extra:${key}`]}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="template-field template-field--wide">
            <span className="attachment-label">Add a field</span>
            <div className="entity-editor-add-field">
              <input
                aria-label="New field name"
                disabled={isSaving}
                onChange={(event) => setNewExtraKey(event.target.value)}
                placeholder="field_name"
                type="text"
                value={newExtraKey}
              />
              <input
                aria-label="New field value"
                disabled={isSaving}
                onChange={(event) => setNewExtraValue(event.target.value)}
                placeholder="value"
                type="text"
                value={newExtraValue}
              />
            </div>
          </div>

          {error ? (
            <p
              aria-live="polite"
              className="form-message form-message--error template-field--wide"
            >
              {error}
            </p>
          ) : null}

          <div className="entity-editor-actions template-field--wide">
            <button className="primary-button" disabled={isSaving} type="submit">
              {isSaving ? "Saving…" : "Save changes"}
            </button>
            <button
              className="secondary-button"
              disabled={isSaving}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {fields === null && error ? (
        <p className="form-message form-message--error">{error}</p>
      ) : null}
    </section>
  );
}
