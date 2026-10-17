# Proposal

## Why

The two moments a demo lives for — "the money went through" and "the kitchen got it" — pass in
silence today. A diner who pays sees at most a toast that vanishes in under three seconds, and the
kitchen screen draws a new ticket without a sound, so a cook with their back to it misses it.
Before showing Ronda to a partner and to bars, both moments should be felt, not just rendered.

## What Changes

- The kitchen screen plays a short chime when a ticket it has not shown before arrives. Browsers
  only allow sound after a tap on the page, so the screen offers a "Sonido" control that turns
  it on (the first tap) and mutes it again; the choice is remembered on that screen.
- The diner's phone shows a short celebration when one of their payments is confirmed — paid
  through Wompi (including a confirmation that arrives after they came back), the simulated
  payment, or cash/card terminal registered by the waiter: a check that draws itself, "¡Pagado!"
  and the amount, a short vibration where the phone supports it. It closes by itself or with a
  tap. With reduced motion it appears without movement.
- `/api/state` gains `my_payments` (how many confirmed payments this diner has, and the amount of
  the latest), which is what lets the phone notice a payment no matter how it was confirmed.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `kitchen-display`: adds the requirement that a new ticket is announced with a sound the staff
  can turn on and mute.
- `diner-screen`: adds the requirement that a diner's confirmed payment is celebrated on their
  own phone, once per payment.

## Impact

- `public/kds/kds.js`, `public/kds/index.html`, `public/kds/kds.css`: sound control, new-ticket
  detection, a chime synthesized with Web Audio (no audio file, no dependency).
- `public/app.js`, `public/index.html`, `public/style.css`: celebration overlay, detection from
  `my_payments`, the Wompi-return toast for approved payments replaced by the celebration.
- `src/api/server.mjs`: `my_payments` in the state query (read-only; counts `contributions`).
- No migration, no change to payments, dispatch or any invariant.
