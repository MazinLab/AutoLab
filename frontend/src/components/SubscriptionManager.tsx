import { useEffect, useState, type ReactElement } from "react";

import {
  createSubscription,
  deleteSubscription,
  getWhoami,
  listSubscriptions,
  type EntityType,
  type Subscription,
} from "../api/client";

const SUBSCRIBABLE_TYPES: EntityType[] = [
  "wafer",
  "device",
  "measurement_run",
  "analysis_run",
  "experiment_setup",
  "substrate_batch",
  "design",
  "fab_step",
  "note",
  "artifact",
];

const ACTIONS = ["created", "updated", "deleted"];

interface SubscriptionManagerProps {
  personId: string;
}

/* Standing DM rules, shown only on your own person page: subscriptions
   belong to the viewer, and identity comes from the network, not the URL. */
export function SubscriptionManager({
  personId,
}: SubscriptionManagerProps): ReactElement | null {
  const [isSelf, setIsSelf] = useState(false);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [entityType, setEntityType] = useState<EntityType>("wafer");
  const [action, setAction] = useState("created");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWhoami()
      .then((whoami) => {
        if (!cancelled && whoami.person?.id === personId) {
          setIsSelf(true);
          return listSubscriptions(personId).then((rows) => {
            if (!cancelled) {
              setSubscriptions(rows);
            }
          });
        }
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [personId]);

  if (!isSelf) {
    return null;
  }

  async function add(): Promise<void> {
    setError(null);
    try {
      const created = await createSubscription({
        person_id: personId,
        entity_type: entityType,
        action,
      });
      setSubscriptions((current) => [...current, created]);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The subscription could not be created.",
      );
    }
  }

  async function remove(id: string): Promise<void> {
    setError(null);
    try {
      await deleteSubscription(id);
      setSubscriptions((current) =>
        current.filter((subscription) => subscription.id !== id),
      );
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The subscription could not be removed.",
      );
    }
  }

  return (
    <section
      aria-labelledby="subscriptions-heading"
      className="entity-section subscription-manager"
    >
      <p className="eyebrow">Slack DMs</p>
      <h2 id="subscriptions-heading">Notification subscriptions</h2>
      {subscriptions.length === 0 ? (
        <p className="subscription-empty">
          No subscriptions yet. DMs go to the Slack ID on your person
          record.
        </p>
      ) : (
        <ul className="subscription-list">
          {subscriptions.map((subscription) => (
            <li className="subscription-row" key={subscription.id}>
              <span>
                {subscription.entity_type.replaceAll("_", " ")}{" "}
                {subscription.action}
              </span>
              <button
                onClick={() => void remove(subscription.id)}
                type="button"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="subscription-add">
        <label>
          Type
          <select
            onChange={(event) =>
              setEntityType(event.target.value as EntityType)
            }
            value={entityType}
          >
            {SUBSCRIBABLE_TYPES.map((subscribable) => (
              <option key={subscribable} value={subscribable}>
                {subscribable.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          Action
          <select
            onChange={(event) => setAction(event.target.value)}
            value={action}
          >
            {ACTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => void add()} type="button">
          Subscribe
        </button>
      </div>
      {error ? (
        <p className="form-message form-message--error">{error}</p>
      ) : null}
    </section>
  );
}
