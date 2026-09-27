# Spec Delta

## MODIFIED Requirements

### Requirement: An alert clears when its causes are resolved

After a staff action, if the session it concerns is `requires_staff_attention` and no reason
remains, the session SHALL return to `settling` when the bill was asked for, and to `open`
otherwise. A session that still has a reason SHALL stay flagged, and an automatic event that
creates a new reason SHALL flag it again.

#### Scenario: The late payment was returned

- **WHEN** the only reason a table was flagged is a credited payment, and staff mark its refund
  `completed`
- **THEN** the session is `open` and the table disappears from the alerts

#### Scenario: Resolved during settlement

- **WHEN** a table that asked for the bill was flagged for a credited payment, and staff complete
  its refund
- **THEN** the session is `settling` again, not `open`

#### Scenario: One of two problems solved

- **WHEN** a table has a credited payment and a failed delivery, and staff retry the delivery
- **THEN** the table stays listed with the money reason only

## ADDED Requirements

### Requirement: Late money on a closed table is still reported

A `closed` session that receives money which could not be placed SHALL stay `closed` — its table
may already be seating the next party — but SHALL be listed with the staff alerts, with reason
"money not placed", until refunds completed against that money cover it.

#### Scenario: The table closed before a late payment arrived

- **WHEN** a table closed after its tab was paid, and a lapsed tab reservation's payment then
  arrives
- **THEN** the money is credited, the session stays `closed`, and the table is listed in the
  alerts until staff complete a refund for it
