# Design

## Context

- The kitchen screen polls `/kds/api/state` every 3 s and redraws. `kds.js` already tells "arrived
  while the screen was open" from "was there on load": a `seen` set of ticket keys plus a `primed`
  flag set after the first successful poll, used today to animate new cards in.
- The diner's screen polls `/api/state` every 2 s. A payment can be confirmed four ways: the
  simulated payment (`/api/dev/pay`, answer `settled`), Wompi on return (`/api/payments/reconcile`,
  outcome `approved`), a Wompi webhook that lands later, and a cash/card-terminal payment staff
  register (`manual_payments`, which settles through `reserve_contribution` + the same
  confirmation path). All four end in a row in `contributions` for the paying participant.
- Paying through Wompi leaves the page and comes back to a fresh load, so anything the phone
  remembers about "before" has to survive a navigation.

## Goals / Non-Goals

**Goals:**
- One detection path for the celebration that covers all four confirmations.
- Sound that works within browser autoplay rules, without an audio file or a dependency.
- Both observable from end-to-end tests without real audio or real vibration.

**Non-Goals:**
- Sounds for anything other than a new ticket (alerts, cash requests, collections).
- Celebrating on the other diners' phones, or for the table as a whole.
- A sound on the diner's phone.

## Decisions

**1. The phone detects a payment by counting, not by watching messages.**
`/api/state` adds `my_payments: { count, last_amount }` — the number of `contributions` rows for
this participant and `order_amount + tip_amount` of the newest. The phone stores the last count it
saw in `localStorage`, keyed by participant id. On every state: no stored value → store it, no
celebration (a diner arriving, or the same diner on a new device); a higher count → celebrate with
`last_amount`, then store. Because the stored value survives the Wompi round trip, the return page
celebrates on its first state load; a late webhook celebrates on the next poll; the simulated and
cash payments too. *Alternatives:* celebrating from each call site (dev pay, reconcile answer) —
misses late webhooks and cash; watching `my_reservation` disappear — cannot tell paid from expired.
Counting rows is read-only and cannot double-celebrate across reloads.

**2. Wompi's "approved" toast gives way to the celebration.**
`checkReturnFromWompi` keeps its toast for declined / pending / credited / not found; for
`approved` it shows nothing itself, since the count-based celebration fires on the same refresh.
The simulated payment's "Pagado" toast is dropped for the same reason. Two messages saying the
same thing would undercut the moment.

**3. The celebration is a small overlay, not a sheet.**
A centered card over a dimmed page: an SVG check whose stroke draws in (stroke-dashoffset,
~450 ms, `cubic-bezier(0.23, 1, 0.32, 1)`), the card scaling from 0.96 with opacity, "¡Pagado!"
and the amount. It closes after ~2.6 s or on tap; it never takes focus away from a sheet the
diner opened. `navigator.vibrate([14, 60, 22])` where it exists — iOS Safari has no Vibration API,
so iPhones get the visual only. Under `prefers-reduced-motion: reduce` the card fades in with no
scale and the check is drawn already.

**4. The chime is synthesized with Web Audio.**
Two short sine notes (a rising fifth, ~0.35 s total, soft attack and decay) from an
`AudioContext`. No file to load, nothing to cache, no dependency. Browsers start an
`AudioContext` suspended until a user gesture, so the context is created/resumed on the first
pointer or key event anywhere on the screen.

**5. One sound control in the top bar.**
A button next to "Hoy" and "Carta": "🔇 Toca para sonido" while the browser has not allowed audio,
"🔔 Sonido" when on, "🔕 Silencio" when muted. Tapping it toggles mute (and, the first time, is
the gesture that unlocks audio). Mute is stored in `localStorage`. The chime decision reuses the
existing `seen`/`primed` logic: after priming, a render that adds at least one never-seen ticket
key plays the chime once.

**6. Testable without speakers.**
Each chime increments `document.body.dataset.chimes`; the celebration is a DOM element with
`hidden` and the amount as text. End-to-end tests assert on those, not on audio or vibration.

## Risks / Trade-offs

- [The kitchen tablet sleeps or the tab is in the background and the browser suspends audio] →
  the control falls back to "Toca para sonido" whenever the context is not running, so staff can
  see it.
- [A diner clears site data between paying and returning] → no stored count, so no celebration;
  the existing Wompi toast path for non-approved outcomes is unaffected and the payment itself is
  intact. Acceptable.
- [`my_payments` counts a payment that landed as table credit (approved but unplaceable)] → the
  celebration would say "¡Pagado!" while the return toast says it became credit. The phone shows
  the credited message instead when the reconcile answer is `credited` and skips that one
  celebration.
- [Chime volume competes with a loud kitchen] → kept short and clear rather than loud; the device
  volume is the real control.

## Migration Plan

Front-end plus one read-only field in the state query. No migration. Rollback is reverting the
commit; old clients ignore `my_payments`.
