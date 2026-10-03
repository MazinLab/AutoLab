import {
  type ChangeEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";

import {
  ACTOR_STORAGE_KEY,
  getWhoami,
  listEntities,
  patchEntity,
  type Entity,
  type Whoami,
} from "../api/client";

/* Fired by the New-record page after a person is created so the picker can
   refresh; detail.select asks it to adopt the new person as the actor. */
export const PERSON_CREATED_EVENT = "autolab:person-created";

const NEW_PERSON_VALUE = "__new-person__";

interface ActorOption {
  id: string;
  label: string;
  entityType: "person" | "agent";
}

function storedActorId(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(ACTOR_STORAGE_KEY)?.trim() ?? "";
}

function actorLabel(actor: Entity): string {
  const actorType = actor.entity_type === "person" ? "person" : "agent";
  return `${actor.name || actor.accession} — ${actorType}`;
}

export function ActorPicker(): ReactElement {
  const selectId = useId();
  const navigate = useNavigate();
  const [selectedActorId, setSelectedActorId] = useState(storedActorId);
  const [actors, setActors] = useState<ActorOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Whoami | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);

  const loadActors = useCallback(async (): Promise<void> => {
    try {
      const [people, agents] = await Promise.all([
        listEntities("person", { limit: 100 }),
        listEntities("agent", { limit: 100 }),
      ]);
      setActors(
        [...people, ...agents]
          .map((actor) => ({
            id: actor.id,
            label: actorLabel(actor),
            entityType: (actor.entity_type === "person"
              ? "person"
              : "agent") as "person" | "agent",
          }))
          .sort((left, right) => left.label.localeCompare(right.label)),
      );
      setLoadError(null);
    } catch (error: unknown) {
      setLoadError(
        error instanceof Error ? error.message : "Actors could not be loaded.",
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadActors();

    // Network identity is a convenience: when it cannot be resolved (dev
    // mode, identity disabled) the picker simply behaves as before.
    void getWhoami()
      .then((whoami) => {
        if (!cancelled) {
          setIdentity(whoami);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [loadActors]);

  useEffect(() => {
    function onPersonCreated(event: Event): void {
      const detail = (event as CustomEvent<{ id?: string; select?: boolean }>)
        .detail;
      void loadActors();
      if (detail?.select && detail.id) {
        setSelectedActorId(detail.id);
      }
    }
    window.addEventListener(PERSON_CREATED_EVENT, onPersonCreated);
    return () => {
      window.removeEventListener(PERSON_CREATED_EVENT, onPersonCreated);
    };
  }, [loadActors]);

  function selectActor(event: ChangeEvent<HTMLSelectElement>): void {
    const actorId = event.target.value;
    if (actorId === NEW_PERSON_VALUE) {
      navigate("/new?template=Person&actor=1");
      return;
    }
    setSelectedActorId(actorId);
    setLinkError(null);
    if (actorId) {
      window.localStorage.setItem(ACTOR_STORAGE_KEY, actorId);
    } else {
      window.localStorage.removeItem(ACTOR_STORAGE_KEY);
    }
  }

  async function linkLogin(): Promise<void> {
    if (!identity?.login || !selectedActorId) {
      return;
    }
    setLinking(true);
    setLinkError(null);
    try {
      const updated = await patchEntity("person", selectedActorId, {
        tailscale_login: identity.login,
      });
      setIdentity({ login: identity.login, person: updated.data, mapped: true });
    } catch (error: unknown) {
      setLinkError(
        error instanceof Error ? error.message : "Linking failed.",
      );
    } finally {
      setLinking(false);
    }
  }

  const resolvedPerson = identity?.person ?? null;
  const resolvedId = resolvedPerson ? resolvedPerson.id : "";

  /* Pinning your own record is redundant with the identity default (and the
     default follows whois if someone else picks up the device), so the
     resolved person is hidden from the roster and a stale self-pin from an
     earlier session collapses back to the default. */
  useEffect(() => {
    if (resolvedId && selectedActorId === resolvedId) {
      setSelectedActorId("");
      window.localStorage.removeItem(ACTOR_STORAGE_KEY);
    }
  }, [resolvedId, selectedActorId]);

  const rosterActors = actors.filter((actor) => actor.id !== resolvedId);
  const includesStoredActor = rosterActors.some(
    (actor) => actor.id === selectedActorId,
  );
  const actingAsOther = Boolean(
    selectedActorId && resolvedId && selectedActorId !== resolvedId,
  );
  const selectedOption = actors.find((actor) => actor.id === selectedActorId);
  const canLink = Boolean(
    identity?.login &&
      !identity.mapped &&
      selectedActorId &&
      selectedOption?.entityType === "person",
  );

  return (
    <div className="actor-picker-block">
      <div className="actor-picker">
        <label htmlFor={selectId}>Actor</label>
        <select
          aria-describedby={loadError ? `${selectId}-error` : undefined}
          id={selectId}
          onChange={selectActor}
          value={selectedActorId}
        >
          <option value="">
            {resolvedPerson
              ? `${resolvedPerson.name || resolvedPerson.accession} (you)`
              : "Unattributed"}
          </option>
          {selectedActorId &&
          selectedActorId !== resolvedId &&
          !includesStoredActor ? (
            <option value={selectedActorId}>Saved actor — unavailable</option>
          ) : null}
          {rosterActors.map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.label}
            </option>
          ))}
          <option value={NEW_PERSON_VALUE}>+ Add a person…</option>
        </select>
        {loadError ? (
          <span className="visually-hidden" id={`${selectId}-error`}>
            {loadError}
          </span>
        ) : null}
      </div>
      {actingAsOther ? (
        <p className="actor-picker-note actor-picker-note--acting">
          Acting as {selectedOption?.label ?? "the saved actor"} — you are{" "}
          {resolvedPerson?.name || resolvedPerson?.accession}.
        </p>
      ) : null}
      {identity?.login && !identity.mapped ? (
        <p className="actor-picker-note">
          Signed in as {identity.login}
          {canLink ? (
            <button
              className="link-login-button"
              disabled={linking}
              onClick={() => void linkLogin()}
              type="button"
            >
              {linking ? "Linking…" : "Link to selected person"}
            </button>
          ) : (
            <> — select your person entry to link it.</>
          )}
        </p>
      ) : null}
      {linkError ? (
        <p className="actor-picker-note form-message--error">{linkError}</p>
      ) : null}
    </div>
  );
}
