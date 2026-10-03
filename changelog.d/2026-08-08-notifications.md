# Slack DM notifications

- Standing subscriptions: on your own person page, subscribe to record
  types ("DM me when a wafer is created"); the dispatcher tails the event
  feed every 30 s and DMs you via the Slack ID on your person record.
- Sender-initiated notifies: Device, Wafer Measurement, Experiment, and
  Analysis forms carry a "Notify people" picker — selected colleagues get
  a one-shot DM with a deep link when the record is created, and a
  `notified` audit event records who was told.
- Delivery is at-least-once through a retrying outbox; permanent failures
  (no Slack ID, unknown user) are dead-lettered visibly, and one bad
  recipient never blocks the feed. Without a bot token configured,
  matching runs and delivery waits.
