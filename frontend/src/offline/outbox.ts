import {
  ApiError,
  createEntity,
  currentActorId,
  type EntityInput,
  type EntityType,
} from "../api/client";

/** Queued catalog writes that failed on network, replayed when back online.
 *
 * Records only — file attachments cannot be queued (localStorage holds no
 * blobs), and the create's `source_key` makes replay idempotent: a request
 * that actually reached the server before the connection dropped will not
 * create a duplicate. Entries the server permanently rejects at replay are
 * kept in a dead-letter list so the typed text is never silently lost.
 */

const OUTBOX_STORAGE_KEY = "autolab.outbox";
const DEAD_LETTER_STORAGE_KEY = "autolab.outbox.dead";
// Oldest dead-lettered entries are dropped past this point; rejected records
// should be copied out or discarded, not hoarded.
const DEAD_LETTER_LIMIT = 20;
export const OUTBOX_CHANGED_EVENT = "autolab:outbox-changed";

export interface QueuedCreate {
  id: string;
  entityType: EntityType;
  payload: EntityInput;
  queuedAt: string;
  /** Actor selected when the record was authored: an entity id, or null for
   * "no actor selected" (replay then sends no actor header). Absent on
   * entries queued before this field existed; those replay with whatever
   * actor is globally selected at flush time. */
  actorId?: string | null;
}

export interface DeadLetteredCreate {
  entry: QueuedCreate;
  detail: string;
  deadLetteredAt: string;
}

// Some non-browser hosts (Node's localStorage stub in test runners) expose a
// localStorage object without functional methods; keep a session-scoped
// in-memory queue there so enqueue still works for the page's lifetime. Real
// browsers always provide functional methods when storage is accessible, so
// the genuine failure modes — quota throws, blocked-storage access throws,
// silent no-op writes — all still surface from enqueueCreate's verification.
let memoryFallback: Map<string, string> | null = null;

function hasFunctionalLocalStorage(): boolean {
  const storage = window.localStorage as Partial<Storage> | undefined;
  return (
    typeof storage?.getItem === "function" &&
    typeof storage?.setItem === "function"
  );
}

function storageRead(key: string): string | null {
  if (hasFunctionalLocalStorage()) {
    return window.localStorage.getItem(key);
  }
  return memoryFallback?.get(key) ?? null;
}

function storageWrite(key: string, value: string): void {
  if (hasFunctionalLocalStorage()) {
    window.localStorage.setItem(key, value);
    return;
  }
  (memoryFallback ??= new Map()).set(key, value);
}

function readStoredArray<T>(key: string): T[] {
  try {
    const raw = storageRead(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function readOutbox(): QueuedCreate[] {
  return readStoredArray<QueuedCreate>(OUTBOX_STORAGE_KEY);
}

function readDeadLetters(): DeadLetteredCreate[] {
  return readStoredArray<DeadLetteredCreate>(DEAD_LETTER_STORAGE_KEY);
}

function writeStoredArray(key: string, entries: unknown[]): void {
  try {
    storageWrite(key, JSON.stringify(entries));
  } catch {
    // Storage full or unavailable; enqueueCreate verifies its own writes,
    // and flush-time removal failures only mean an idempotent replay later.
  }
  window.dispatchEvent(new CustomEvent(OUTBOX_CHANGED_EVENT));
}

export function pendingCreates(): QueuedCreate[] {
  return readOutbox();
}

export function deadLetteredCreates(): DeadLetteredCreate[] {
  return readDeadLetters();
}

/** Drop one dead-lettered entry for good (after the user copied it out). */
export function discardDeadLetter(entryId: string): void {
  writeStoredArray(
    DEAD_LETTER_STORAGE_KEY,
    readDeadLetters().filter((item) => item.entry.id !== entryId),
  );
}

/** True for errors where the request may never have reached the server.
 *
 * fetch signals network failure with a TypeError; anything else (ApiError
 * from a server response, synthetic validation errors) is not offline.
 */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError;
}

export function enqueueCreate(
  entityType: EntityType,
  payload: EntityInput,
): QueuedCreate {
  const entry: QueuedCreate = {
    id: crypto.randomUUID(),
    entityType,
    payload,
    queuedAt: new Date().toISOString(),
    actorId: currentActorId(),
  };
  const failure =
    "The offline queue could not be saved (storage full or disabled) — " +
    "this record is NOT queued. Keep the form open and retry when back online.";
  try {
    storageWrite(OUTBOX_STORAGE_KEY, JSON.stringify([...readOutbox(), entry]));
  } catch (error) {
    throw new Error(failure, { cause: error });
  }
  // setItem can also fail silently (private-mode shims, no-op storage):
  // verify the entry actually persisted before reporting success.
  if (!readOutbox().some((queued) => queued.id === entry.id)) {
    throw new Error(failure);
  }
  window.dispatchEvent(new CustomEvent(OUTBOX_CHANGED_EVENT));
  return entry;
}

export interface FlushResult {
  sent: number;
  // Entries the server permanently rejected (4xx): moved to the dead-letter
  // list so the UI can offer copy/discard, and reported here for messaging.
  rejected: { entry: QueuedCreate; detail: string }[];
  // Entries still queued (network again, or server 5xx).
  remaining: number;
}

let flushInFlight: Promise<FlushResult> | null = null;

export function flushOutbox(): Promise<FlushResult> {
  if (flushInFlight) {
    return flushInFlight;
  }
  flushInFlight = flushOutboxOnce().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

function deadLetter(entry: QueuedCreate, detail: string): void {
  const dead = [
    ...readDeadLetters(),
    { entry, detail, deadLetteredAt: new Date().toISOString() },
  ];
  writeStoredArray(DEAD_LETTER_STORAGE_KEY, dead.slice(-DEAD_LETTER_LIMIT));
}

async function flushOutboxOnce(): Promise<FlushResult> {
  const entries = readOutbox();
  const processedIds = new Set<string>();
  const rejected: FlushResult["rejected"] = [];
  let sent = 0;
  for (const entry of entries) {
    // Forms stamp a source_key before the first network attempt; only fall
    // back to the outbox id when the queued payload does not carry one.
    const stampedKey = entry.payload["source_key"];
    const payload =
      typeof stampedKey === "string" && stampedKey
        ? entry.payload
        : { ...entry.payload, source_key: `outbox:${entry.id}` };
    try {
      await createEntity(
        entry.entityType,
        payload,
        // Legacy entries without the field keep the old behavior (whatever
        // actor is selected now); new entries replay the captured actor,
        // including "none selected" (null → no actor header).
        entry.actorId === undefined ? {} : { actorId: entry.actorId },
      );
      sent += 1;
      processedIds.add(entry.id);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        rejected.push({ entry, detail: error.message });
        deadLetter(entry, error.message);
        processedIds.add(entry.id);
      }
      // Network or 5xx: leave the entry queued for the next flush.
    }
  }
  // Entries enqueued while the network calls were in flight must survive:
  // re-read storage and remove only what this flush actually processed,
  // never overwrite with the stale snapshot.
  const remaining = readOutbox().filter((entry) => !processedIds.has(entry.id));
  writeStoredArray(OUTBOX_STORAGE_KEY, remaining);
  return { sent, rejected, remaining: remaining.length };
}
