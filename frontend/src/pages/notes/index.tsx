import {
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useSearchParams } from "react-router-dom";

import {
  createEntity,
  resolveAccession,
  searchEntities,
  uploadArtifact,
  type Entity,
  type EntityLink,
  type SearchResult,
} from "../../api/client";
import { Markdown } from "../../components/Markdown";
import { enqueueCreate, isNetworkFailure } from "../../offline/outbox";
import "./notes.css";

interface MentionTrigger {
  end: number;
  query: string;
  start: number;
}

function findMentionTrigger(value: string, cursor: number): MentionTrigger | null {
  const textBeforeCursor = value.slice(0, cursor);
  const match = textBeforeCursor.match(/\[\[([^\[\]]*)$/);
  if (!match || match.index === undefined) {
    return null;
  }
  return {
    end: cursor,
    query: match[1],
    start: match.index,
  };
}

function quickNoteName(body: string): string {
  return body.trim().split(/\r?\n/, 1)[0]?.trim() || "Quick note";
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}`;
}

function bodyAccessions(body: string): string[] {
  return [...body.matchAll(/\[\[([^\[\]]+)\]\]/g)]
    .map((match) => match[1].trim())
    .filter((accession) => accession.length > 0);
}

// Every [[accession]] in the body becomes a refers_to reference: tokens the
// user picked via autocomplete resolve from that selection; manually typed
// ones are looked up in the catalog. An unknown accession aborts the note.
async function collectReferences(
  body: string,
  selected: SearchResult[],
): Promise<SearchResult[]> {
  const references = new Map<string, SearchResult>();
  for (const reference of selected) {
    if (body.includes(`[[${reference.accession}]]`)) {
      references.set(reference.accession, reference);
    }
  }
  for (const accession of bodyAccessions(body)) {
    if (references.has(accession)) {
      continue;
    }
    try {
      const resolved = await resolveAccession(accession);
      references.set(accession, resolved.data);
    } catch (error: unknown) {
      if (isNetworkFailure(error)) {
        // Offline: let the caller queue the note; the server resolves
        // accessions at replay via dst_accession links.
        throw error;
      }
      throw new Error(
        `[[${accession}]] does not match any catalog record. ` +
          "Fix or remove it; the note was not created.",
      );
    }
  }
  return [...references.values()];
}

export function QuickNotePage(): ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // /notes/new?mention=W-2026-0001 (the entity page's "+ New note" button)
  // seeds the note with a reference token; it resolves at submit like any
  // manually typed [[accession]].
  const [searchParams] = useSearchParams();
  const mentionParam = searchParams.get("mention")?.trim();
  const [body, setBody] = useState(() =>
    mentionParam ? `[[${mentionParam}]]\n\n` : "",
  );
  const [mention, setMention] = useState<MentionTrigger | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedReferences, setSelectedReferences] = useState<SearchResult[]>([]);
  const [createdEntity, setCreatedEntity] = useState<Entity | null>(null);
  const [createdReferences, setCreatedReferences] = useState<SearchResult[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [queuedOffline, setQueuedOffline] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  // Names of files whose upload failed after the note itself was created.
  const [failedUploads, setFailedUploads] = useState<string[]>([]);
  // Per-file upload error, keyed by name:size; the failed File objects stay
  // in `attachments` so a camera shot is never lost to a flaky upload.
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});
  // The note went to the offline outbox, which cannot hold file blobs.
  const [attachmentsDropped, setAttachmentsDropped] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  // Idempotency key for the note being drafted, minted before the FIRST
  // create attempt and reused on retries after non-network errors: if the
  // server committed but the response was lost, the outbox replay carries
  // the SAME key and dedupes instead of duplicating the note. Cleared when
  // the note is confirmed created or queued (the next note is a new record).
  const sourceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const query = mention?.query.trim() ?? "";
    if (!query) {
      setResults([]);
      setIsSearching(false);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    setIsSearching(true);
    setSearchError(null);
    const timeoutId = window.setTimeout(() => {
      void searchEntities(query, 8)
        .then((matches) => {
          if (!cancelled) {
            setResults(matches);
            setSearchError(null);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setSearchError(
              error instanceof Error ? error.message : "Entity search failed.",
            );
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsSearching(false);
          }
        });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [mention]);

  function updateBody(event: ChangeEvent<HTMLTextAreaElement>): void {
    const nextBody = event.target.value;
    setBody(nextBody);
    setMention(findMentionTrigger(nextBody, event.target.selectionStart));
    setSelectedReferences((current) =>
      current.filter((reference) =>
        nextBody.includes(`[[${reference.accession}]]`),
      ),
    );
    setCreatedEntity(null);
    setCreatedReferences([]);
    setFailedUploads([]);
    setAttachmentsDropped(false);
  }

  // Upload each file on its own so one failure never hides the others;
  // returns the files that failed with their error messages.
  async function uploadAttachmentsTo(
    noteId: string,
    files: File[],
  ): Promise<{ failed: File[]; errors: Record<string, string> }> {
    const failed: File[] = [];
    const errors: Record<string, string> = {};
    for (const file of files) {
      try {
        await uploadArtifact(file, {
          linkEntityId: noteId,
          relation: "annotates",
        });
      } catch (uploadError: unknown) {
        failed.push(file);
        errors[fileKey(file)] =
          uploadError instanceof Error
            ? uploadError.message
            : "The upload failed.";
      }
    }
    return { failed, errors };
  }

  // Failed uploads keep their File objects, so they can be retried against
  // the already-created note without recapturing anything.
  async function retryUploads(): Promise<void> {
    if (!createdEntity || attachments.length === 0) {
      return;
    }
    setIsSubmitting(true);
    try {
      const { failed, errors } = await uploadAttachmentsTo(
        createdEntity.id,
        attachments,
      );
      setAttachments(failed);
      setUploadErrors(errors);
      setFailedUploads(failed.map((file) => file.name));
    } finally {
      setIsSubmitting(false);
    }
  }

  function addAttachments(picked: FileList | null): void {
    if (!picked || picked.length === 0) {
      return;
    }
    // Copy now: Safari empties this FileList in place when the input is
    // cleared, which happens before React runs the updater.
    const files = Array.from(picked);
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

  function insertEntity(result: SearchResult): void {
    if (!mention) {
      return;
    }
    const entityLink = `[[${result.accession}]]`;
    const cursor = mention.start + entityLink.length;
    setBody(
      (current) =>
        `${current.slice(0, mention.start)}${entityLink}${current.slice(mention.end)}`,
    );
    setSelectedReferences((current) =>
      current.some((reference) => reference.id === result.id)
        ? current
        : [...current, result],
    );
    setMention(null);
    setResults([]);
    window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    }, 0);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitError(null);
    setIsSubmitting(true);
    // One key per logical note, minted before the first attempt and kept
    // across retries so replays dedupe server-side.
    const sourceKey = sourceKeyRef.current ?? `web:${crypto.randomUUID()}`;
    sourceKeyRef.current = sourceKey;

    try {
      const references = await collectReferences(body, selectedReferences);
      const links: EntityLink[] = references.map((reference) => ({
        relation: "refers_to",
        dst_id: reference.id,
      }));
      // Links ride in the create payload; the note and its edges are one
      // transaction server-side.
      const note = await createEntity("note", {
        name: quickNoteName(body),
        body,
        source_key: sourceKey,
        ...(links.length > 0 ? { links } : {}),
      });
      // The note is confirmed committed; the next note is a new record.
      sourceKeyRef.current = null;

      // The note exists now; a failed upload must not undo or hide it, so
      // each file is tried on its own. Failed files STAY selected with
      // their error, ready to retry — a camera shot is unrecoverable.
      const { failed, errors } = await uploadAttachmentsTo(
        note.id,
        attachments,
      );

      setCreatedEntity(note);
      setCreatedReferences(references);
      setQueuedOffline(false);
      setFailedUploads(failed.map((file) => file.name));
      setUploadErrors(errors);
      setAttachmentsDropped(false);
      setAttachments(failed);
      setBody("");
      setMention(null);
      setResults([]);
      setSelectedReferences([]);
    } catch (error: unknown) {
      if (isNetworkFailure(error)) {
        // The typed note must survive the dead zone: queue it with
        // accession links the server resolves at replay. The queued payload
        // carries the SAME source_key as the failed POST, so if that POST
        // actually reached the server the replay dedupes.
        const links: EntityLink[] = bodyAccessions(body).map((accession) => ({
          relation: "refers_to",
          dst_accession: accession,
        }));
        try {
          enqueueCreate("note", {
            name: quickNoteName(body),
            body,
            source_key: sourceKey,
            ...(links.length > 0 ? { links } : {}),
          });
        } catch {
          // The outbox could not be persisted: nothing was stored anywhere.
          // Keep the whole draft (body, references, attachments) and say so.
          setSubmitError(
            "You appear to be offline and the note could not be queued " +
              "for later sync. Your draft is kept — retry when the " +
              "connection returns.",
          );
          return;
        }
        sourceKeyRef.current = null;
        setQueuedOffline(true);
        setCreatedEntity(null);
        setCreatedReferences([]);
        // localStorage holds no blobs: the queued note syncs later. The
        // selected files stay listed so they are not lost — attach them to
        // the synced note (or a follow-up note) once back online.
        setAttachmentsDropped(attachments.length > 0);
        setFailedUploads([]);
        setUploadErrors({});
        setBody("");
        setMention(null);
        setResults([]);
        setSelectedReferences([]);
      } else {
        setSubmitError(
          error instanceof Error
            ? error.message
            : "The note could not be created.",
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="page-panel capture-page">
      <p className="eyebrow">Notebook</p>
      <h1>Quick note</h1>
      <p className="lede">
        Write in Markdown. Type <code>[[</code> to link a catalog entity by
        accession.
      </p>
      <form className="quick-note-form" onSubmit={(event) => void submit(event)}>
        <div className="template-field template-field--wide">
          <label htmlFor="quick-note-body">Markdown note</label>
          {/* MarkdownEditor cannot host the [[mention]] autocomplete (its
              onChange drops the selection and it hides its textarea ref), so
              the quick note keeps its own textarea and adds a preview tab
              that reuses the same Markdown renderer. */}
          <div className="markdown-editor quick-note-editor">
            <div className="markdown-toolbar">
              <div className="markdown-toolbar-spacer" />
              <button
                aria-pressed={!isPreviewing}
                className="markdown-tab"
                onClick={() => setIsPreviewing(false)}
                type="button"
              >
                Write
              </button>
              <button
                aria-pressed={isPreviewing}
                className="markdown-tab"
                onClick={() => {
                  setIsPreviewing(true);
                  setMention(null);
                  setResults([]);
                }}
                type="button"
              >
                Preview
              </button>
            </div>
            {isPreviewing ? (
              <div aria-label="Markdown preview" className="markdown-preview">
                {body.trim() ? (
                  <Markdown source={body} />
                ) : (
                  <p className="empty-state">Nothing to preview.</p>
                )}
              </div>
            ) : (
              <textarea
                id="quick-note-body"
                onChange={updateBody}
                placeholder="What happened? Link records with [[accession]]."
                ref={textareaRef}
                required
                rows={14}
                value={body}
              />
            )}
          </div>
        </div>
        {mention ? (
          <div className="mention-results" aria-live="polite">
            {!mention.query.trim() ? <p>Type a name to search the catalog.</p> : null}
            {isSearching ? <p>Searching…</p> : null}
            {searchError ? <p className="field-error">{searchError}</p> : null}
            {results.length > 0 ? (
              <ul className="autocomplete-results">
                {results.map((result) => (
                  <li key={result.id}>
                    <button type="button" onClick={() => insertEntity(result)}>
                      <strong>{result.accession}</strong>
                      <span>{result.name || result.entity_type}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div className="quick-note-attachments">
          <label className="attachment-browse attach-source">
            Take photo
            <input
              accept="image/*"
              aria-label="Take a photo to attach"
              capture="environment"
              disabled={isSubmitting}
              onChange={(event) => {
                addAttachments(event.target.files);
                event.target.value = "";
              }}
              type="file"
            />
          </label>
          <label className="attachment-browse attach-source">
            Choose files
            <input
              aria-label="Attach files"
              disabled={isSubmitting}
              multiple
              onChange={(event) => {
                addAttachments(event.target.files);
                event.target.value = "";
              }}
              type="file"
            />
          </label>
        </div>
        {attachments.length > 0 ? (
          <ul className="attachment-list">
            {attachments.map((file, index) => (
              <li key={`${file.name}-${file.size}`}>
                <span className="attachment-name">{file.name}</span>
                {uploadErrors[fileKey(file)] ? (
                  <span className="attachment-error">
                    {uploadErrors[fileKey(file)]}
                  </span>
                ) : null}
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
        {submitError ? (
          <p aria-live="polite" className="form-message form-message--error">
            {submitError}
          </p>
        ) : null}
        {failedUploads.length > 0 ? (
          <div aria-live="polite" className="form-message form-message--error">
            <p>
              The note was created, but these attachments failed to upload:{" "}
              {failedUploads.join(", ")}. They are still selected above —
              retry or remove them.
            </p>
            {createdEntity ? (
              <button
                className="secondary-button retry-uploads"
                disabled={isSubmitting || attachments.length === 0}
                onClick={() => void retryUploads()}
                type="button"
              >
                {isSubmitting ? "Uploading…" : "Retry failed uploads"}
              </button>
            ) : null}
          </div>
        ) : null}
        {queuedOffline ? (
          <p aria-live="polite" className="form-message form-message--success">
            You appear to be offline — the note is queued and will sync
            automatically when the connection returns.
          </p>
        ) : null}
        {attachmentsDropped ? (
          <p aria-live="polite" className="form-message form-message--error">
            Attachments cannot be queued offline — they stay selected above,
            so upload them once the connection returns (from the note page
            after it syncs, or with your next note).
          </p>
        ) : null}
        {createdEntity ? (
          <div aria-live="polite" className="form-message form-message--success">
            <p>
              Created {createdEntity.accession}.{" "}
              <Link to={`/entity/${encodeURIComponent(createdEntity.id)}`}>
                Open note
              </Link>
            </p>
            {createdReferences.length > 0 ? (
              <p>
                Linked references:{" "}
                {createdReferences.map((reference, index) => (
                  <span key={reference.id}>
                    {index > 0 ? ", " : null}
                    <Link to={`/e/${encodeURIComponent(reference.accession)}`}>
                      {reference.accession}
                    </Link>
                  </span>
                ))}
              </p>
            ) : null}
          </div>
        ) : null}
        <button className="primary-button" disabled={isSubmitting} type="submit">
          {isSubmitting ? "Saving…" : "Save note"}
        </button>
      </form>
    </section>
  );
}
