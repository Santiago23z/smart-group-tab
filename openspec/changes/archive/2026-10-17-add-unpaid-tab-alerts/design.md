# Design

## Context

- `staff_alerts(p_stall interval)` lists sessions in `requires_staff_attention` (plus closed ones
  with unplaced money), each with `staff_alert_reasons(session)`: a jsonb array of reasons, each
  with a stable `key`. `acknowledged_at` is shown when `staff_alert_acks.reason_keys` covers every
  current key; `acknowledge_alert(session)` snapshots the keys of `staff_alert_reasons`.
- `staff_resolve_if_clear` returns a flagged session to `open`/`settling` when
  `staff_alert_reasons` is empty. So anything added to `staff_alert_reasons` would keep a flagged
  session flagged.
- `tab_summary(session)` gives the tab total and, per participant, `unpaid` and `held`; the diner
  state and `staff_open_tables` both use it. The tab is `session_tab_shares`: unpaid, unwritten-off
  shares of dispatched rounds with `requires_prepayment = false`; `rounds.dispatched_at` says when
  each went to the kitchen.
- The KDS server reads `KDS_STALL_MINUTES` and passes it to `staff_alerts`.

## Goals / Non-Goals

**Goals:**
- A warning that never changes a session's state and never blocks an alert from clearing.
- Per person: the alert names who has owed too long, and re-appears when someone new crosses.

**Non-Goals:**
- Collecting one person's cash before the bill; a per-venue threshold; notifying diners.

## Decisions

**D1. `unpaid_since` in `tab_summary`.** Per participant, `min(rounds.dispatched_at)` over their
shares in `session_tab_shares`. Additive field; the diner app ignores it.

**D2. `staff_unpaid_reasons(session, threshold) → jsonb`, kept apart from `staff_alert_reasons`.**
One reason per participant whose `unpaid_since < now() - threshold` and `unpaid > 0`:
`{kind: 'tab_unpaid_long', key: 'tab_unpaid:<participant_id>', participant_id, nickname, unpaid,
unpaid_since}`. It is never called by `staff_resolve_if_clear`, so it cannot hold a session
flagged (spec: "It does not keep a flagged table flagged").
*Alternative:* add it to `staff_alert_reasons`. Rejected for exactly that reason.

**D3. `staff_alerts(p_stall, p_unpaid interval default '90 minutes')`.** The listed set becomes the
current one ∪ sessions not `closed` with a non-empty `staff_unpaid_reasons`. `reasons` =
`staff_alert_reasons || staff_unpaid_reasons`. The acknowledged rule is unchanged (keys covered).
Drop and recreate (one signature); one-argument calls keep working through the default.

**D4. `acknowledge_alert(session, p_unpaid interval default '90 minutes')`** snapshots the keys of
both functions. A new person over the threshold brings a new key, so the table shows
unacknowledged again; the same person staying over it does not. The KDS ack route passes the
threshold.

**D5. KDS.** `src/kds/server.mjs` reads `KDS_UNPAID_MINUTES` (default 90) like
`KDS_STALL_MINUTES`; `createKdsServer({ unpaidMinutes })` passes it to `staff_alerts`,
`acknowledge_alert`, and returns it in the state as `unpaid_minutes` for the screen.
- Alert card: `describe()` gets `tab_unpaid_long` → "Ana debe $30.000 hace 2 h 5 min", one line per
  person.
- "Mesas abiertas": each person's line gains "· hace 1 h 20 min" from `unpaid_since` (server clock
  offset already used for tickets), with a warning class when over `unpaid_minutes`; updated by the
  1 s timer like ticket waits.

## Risks / Trade-offs

- [Noise on long, honest dinners] → 90 min default; `KDS_UNPAID_MINUTES` per deployment;
  *Visto* silences it until someone new crosses.
- [A table already flagged for another reason also owes] → Reasons are merged in one card; D2
  keeps resolution correct.
- [Clock] → `unpaid_since` and `now()` both come from the database; the screen only formats the
  difference with the server offset it already keeps.

## Migration Plan

One migration (`tab_summary` replaced, `staff_unpaid_reasons` added, `staff_alerts` and
`acknowledge_alert` dropped and recreated with grants as before). Rollback: restore the previous
three functions; `staff_alert_acks` rows stay valid (extra keys are ignored).
