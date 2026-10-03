import { useCallback, useEffect, useState } from "react";

import {
  deadLetteredCreates,
  discardDeadLetter,
  flushOutbox,
  OUTBOX_CHANGED_EVENT,
  pendingCreates,
  type DeadLetteredCreate,
} from "../offline/outbox";

/** Readable dump of a rejected record for the clipboard — the typed text
 * (name, body, other fields) is what the user must not lose. */
function deadLetterText(item: DeadLetteredCreate): string {
  const { entry } = item;
  const lines = [
    `Rejected ${entry.entityType} (queued ${entry.queuedAt}): ${item.detail}`,
  ];
  for (const [key, value] of Object.entries(entry.payload)) {
    lines.push(
      `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
    );
  }
  return lines.join("\n");
}

/** Pending offline writes: visible whenever the outbox is non-empty, flushed
 * automatically on reconnect and on demand by tapping it. Records the server
 * rejected at replay stay listed here (dead-lettered) until the user copies
 * the text out or discards them. */
export function OutboxIndicator() {
  const [pending, setPending] = useState(() => pendingCreates().length);
  const [dead, setDead] = useState<DeadLetteredCreate[]>(() =>
    deadLetteredCreates(),
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const flush = useCallback(() => {
    void flushOutbox();
  }, []);

  useEffect(() => {
    const refresh = () => {
      setPending(pendingCreates().length);
      setDead(deadLetteredCreates());
    };
    window.addEventListener(OUTBOX_CHANGED_EVENT, refresh);
    window.addEventListener("online", flush);
    if (navigator.onLine && pendingCreates().length > 0) {
      flush();
    }
    return () => {
      window.removeEventListener(OUTBOX_CHANGED_EVENT, refresh);
      window.removeEventListener("online", flush);
    };
  }, [flush]);

  const copy = useCallback((item: DeadLetteredCreate) => {
    void navigator.clipboard.writeText(deadLetterText(item)).then(() => {
      setCopiedId(item.entry.id);
    });
  }, []);

  if (pending === 0 && dead.length === 0) {
    return null;
  }

  return (
    <div className="outbox-indicator" role="status">
      {pending > 0 ? (
        <button
          className="outbox-flush"
          onClick={flush}
          title="Queued records are sent automatically when you are back online; tap to retry now."
          type="button"
        >
          {pending} record{pending === 1 ? "" : "s"} queued offline — tap to
          sync
        </button>
      ) : null}
      {dead.length > 0 ? (
        <div className="outbox-dead">
          <p className="outbox-dead-summary">
            {dead.length} queued record{dead.length === 1 ? " was" : "s were"}{" "}
            rejected by the server. Copy the text out before discarding — it is
            not stored anywhere else.
          </p>
          <ul className="outbox-dead-list">
            {dead.map((item) => (
              <li className="outbox-dead-item" key={item.entry.id}>
                <span className="outbox-dead-name">
                  {typeof item.entry.payload.name === "string" &&
                  item.entry.payload.name
                    ? item.entry.payload.name
                    : item.entry.entityType}
                </span>
                <span className="outbox-dead-detail">{item.detail}</span>
                <span className="outbox-dead-actions">
                  <button
                    className="outbox-copy"
                    onClick={() => copy(item)}
                    type="button"
                  >
                    {copiedId === item.entry.id ? "Copied" : "Copy text"}
                  </button>
                  <button
                    className="outbox-discard"
                    onClick={() => discardDeadLetter(item.entry.id)}
                    type="button"
                  >
                    Discard
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
