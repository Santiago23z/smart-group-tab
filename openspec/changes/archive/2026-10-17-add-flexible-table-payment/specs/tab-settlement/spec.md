# Spec Delta

## MODIFIED Requirements

### Requirement: The tab is paid in one payment per person

A participant SHALL be able to reserve, in one reservation and one checkout, every unpaid share of
the tab that is theirs — in settlement, and also before the bill at an `open_tab` session, while
the table keeps ordering. In settlement a participant SHALL also be able to reserve every unpaid
share of the tab. The reservation SHALL hold those shares exactly as a round reservation does — no
share held by two live reservations, no share paid twice — and SHALL be settled, credited or
released by the same payment outcomes, webhook and reconciliation rules as a round payment.

Paying before the bill SHALL NOT ask for the bill, close the session, or stop anyone from
ordering. Covering the rest of the tab before the bill SHALL be refused.

#### Scenario: One checkout for three rounds

- **WHEN** a diner who ordered in rounds 1, 2 and 3 of an open tab pays "lo mío"
- **THEN** one checkout charges the sum of their shares across the three rounds, and once
  approved those shares are paid

#### Scenario: Two diners cover the rest at once

- **WHEN** two diners reserve "cubrir el resto" of the same tab at the same moment
- **THEN** one of them holds the unpaid shares and the other is refused with nothing available

#### Scenario: A tab payment arrives after its shares were paid by someone else

- **WHEN** an approved tab payment arrives for a lapsed reservation whose shares another diner
  has since paid
- **THEN** it is credited to the session and the session needs staff attention

#### Scenario: Leaving early

- **WHEN** Carla, at an `open_tab` table that has not asked for the bill, pays "lo mío"
- **THEN** her shares are paid, the table can still order, and the bill is not asked for
- **AND** when the bill is asked for later, the tab no longer holds her part

#### Scenario: Not the rest before the bill

- **WHEN** a diner at an `open_tab` table that has not asked for the bill reserves "cubrir el resto"
- **THEN** it is refused because the bill has not been asked for
