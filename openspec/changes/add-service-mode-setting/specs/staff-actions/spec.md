# Spec Delta

## ADDED Requirements

### Requirement: Staff choose how the venue collects

From the kitchen screen, staff SHALL be able to set a venue's collection mode to `pay_before_order`
("Pagar antes") or `open_tab` ("Cuenta abierta"). The screen SHALL show the venue's current mode
and SHALL say that the choice applies to tables opened from then on.

The new mode SHALL govern every session opened after the change. Sessions already open SHALL keep
the mode they copied when they opened.

`hybrid` SHALL NOT be offered as a choice from the kitchen screen. A venue whose current mode is
`hybrid` SHALL see it as its current mode and SHALL be able to switch to either of the two choices.
Any other value SHALL be refused and change nothing.

Changing the mode SHALL require the staff credential and SHALL be logged with the venue, the old
mode and the new mode. Choosing the mode the venue already has SHALL change nothing and log
nothing.

Loading a venue's data again without stating a mode SHALL keep the venue's current mode.

#### Scenario: A venue switches to an open tab

- **WHEN** staff set the venue to "Cuenta abierta"
- **AND** a party then sits at a free table and closes a round
- **THEN** the round goes to the kitchen unpaid, under `open_tab`

#### Scenario: A table already seated keeps its rules

- **WHEN** a table is open under `pay_before_order` and staff switch the venue to `open_tab`
- **THEN** that table's next round is still collected before the kitchen sees it
- **AND** the next session opened at that table is governed by `open_tab`

#### Scenario: Hybrid is not on offer

- **WHEN** staff ask to set the mode to `hybrid`, or to any value other than the two choices
- **THEN** the request is refused and the venue's mode is unchanged

#### Scenario: A venue already in hybrid

- **WHEN** a venue's current mode is `hybrid`
- **THEN** the kitchen screen shows "Híbrido" as its current mode
- **AND** staff can switch it to "Pagar antes" or "Cuenta abierta"

#### Scenario: The change is logged

- **WHEN** staff switch the venue from `pay_before_order` to `open_tab`
- **THEN** the log holds one entry with the venue, the old mode and the new mode

#### Scenario: Without the staff credential

- **WHEN** a request to change the mode arrives without the staff credential
- **THEN** it is refused and the venue's mode is unchanged

#### Scenario: Reloading the venue keeps the choice

- **WHEN** staff set the venue to `open_tab` and the venue is loaded again from the command line
  without a mode
- **THEN** the venue is still `open_tab`
