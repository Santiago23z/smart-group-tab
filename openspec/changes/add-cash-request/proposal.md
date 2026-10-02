# Proposal

## Why

Staff can record cash and card-terminal payments ("Cobrar en caja"), but a diner who wants to
pay that way has no way to say so from the app: they must catch a waiter's eye. In a busy bar
that is the slowest part of paying, and the food (pay-before-order) or the table (open tab) waits
on it.

## What Changes

- In the pay sheet the diner can choose **"Pagar en efectivo"** or **"Con datáfono"** instead of
  Wompi, for their part or for everything still unpaid. The app says the waiter is on the way and
  shows the request until it is resolved, with **Cancelar**.
- The kitchen screen shows it at once in a new top section, **"Quieren pagar"**: table, who, how
  much, cash or terminal, and how long ago — with **Cobrar en caja** already set to that person
  and method, and **Descartar**.
- A request **moves no money and holds nothing**: the diner (or anyone at the table) can still
  pay in Wompi. The request disappears on its own when the part it names is paid by any route,
  and when the diner cancels or staff dismiss it.
- One open request per diner; a new one replaces the old.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `manual-payments`: diners can ask from the app to pay in cash or on the card terminal, and staff
  see and act on the request.

## Impact

- **DB**: `cash_requests` table and three functions (request, cancel, dismiss), with the amount
  computed from what is still unpaid.
- **Code**: diner API routes and state; pay sheet and pay bar; KDS section and prefilled cash
  dialog. No new dependencies.
