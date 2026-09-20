# Smart Group Tab - Project Architecture & AI Guidelines

## 1. Project Context & Vision
- **Core Product:** Real-time collaborative consumption orchestrator for HORECA (bars, gastrobars). It is NOT a simple split-payment app.
- **Identity:** Zero-friction `Guest Session` (QR + Nickname). Phone capture is post-payment only (loyalty incentive).
- **Payment Rails:** Irreversible push payments (Nequi/PSE via Wompi). Money moves immediately; over-collection must be prevented by design, not corrected later.

## 2. Hard Rules & Conventions (NEVER VIOLATE)
- **Nomenclature:** All code, database tables, columns, RPCs, states, and technical comments MUST be strictly in **English**. 
  - *Mappings:* `venues`, `tables`, `sessions`, `rounds`, `cart_items`, `participants`, `contribution_reservations`, `contributions`, `dispatches`, `refunds`, `webhook_events`.
- **Currency:** All money fields must use integers (`bigint`) representing the smallest currency unit. Never use `float` or `decimal`.
- **Item-Level Ledger:** The atomic claim operates on **ITEM SHARES** (`cart_item_shares`), not free amounts. We track who pays for what specific item fraction to enable sharing a single bottle among multiple participants.

## 3. The 3 Architectural Invariants
- **I1 (No Over-collection):** Atomic claims block fractions of items. We use a `contribution_reservations` table with a lazy 5-minute TTL *before* sending the user to the payment gateway.
- **I2 (Exactly-Once Dispatch):** KDS dispatching is done via an explicit state transition + Outbox Worker (`dispatches` table with retries/backoff). NEVER use DB triggers observing total amounts to dispatch to the kitchen.
- **I3 (No Lost Webhooks):** PSP webhooks are ingested idempotently (`webhook_events`). If a webhook arrives late for an expired reservation, the money is still ingested as surplus into the session's `prepaid_balance` and flagged for staff attention.

## 4. State Machines & Cart Lifecycle
- **Round States:** `draft` ➔ `locked_for_payment` ➔ `paid_and_dispatched` (or `requires_staff_attention`). A fifth state, `cancelled`, exists for staff-initiated round cancellation (D2); no automatic transition reaches it.
- **Session States:** `open` ➔ `settling` ➔ `closed`, or `requires_staff_attention`. The staff-attention value is spelled identically in both enums on purpose.
- **Cart Freeze (Overflow):** When a round enters `locked_for_payment`, its cart is frozen. New items added by users automatically overflow into a new `draft` round.
- **Cancellations:** Item removals are ONLY allowed while the round is in `draft`. No discounts are supported in the MVP.
- **Refunds:** Refunds are modeled in the database (table `refunds`) to keep the ledger balanced, but the physical money return is executed **manually** by staff (no automated Wompi API refunds). Two independent axes: `kind` (`reversed`/`refunded`) says *how* the money came back; `status` (`pending`/`completed`/`rejected`) says *how far along* it is. They are not collapsed — a reversal the bank is still processing is `reversed` and `pending` at once, and the UI must not claim the money is back while it is not.

## 5. Operating Modes
- The mode (`pay_before_order`, `open_tab`, `hybrid`) is snapshotted to the session upon creation.
- In `hybrid` mode, round 1 demands 100% upfront payment. Subsequent rounds are financed against a `prepaid_balance` pool at the session level.

## 6. MVP Scope & Deliverables
- **The Goal:** A functional 1-minute end-to-end live demo (QR scan on two concurrent mobile devices ➔ collaborative cart ➔ fractional payment in Wompi sandbox ➔ KDS dispatch).
- **In Scope:** Complete backend (Supabase SQL migrations, RLS, atomic RPCs), Wompi sandbox adapter with HMAC verification, Outbox Worker, and the **KDS Web UI** (the only staff surface).
- **Out of Scope:** Native mobile apps, complex waiter-specific dashboards, automated API refunds, and full menu management panels.

## 7. Workflow & Communication Rules
- **Concise Outputs:** Keep all responses, explanations, and commit messages extremely concise and direct. No long, ambiguous, or conversational filler.
- **Git Protocol:** Every time you complete a feature or logical task, state clearly that it is done, provide a brief summary of what was built, and explicitly ask for permission to `git push`.