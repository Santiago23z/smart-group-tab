# Spec Delta

## ADDED Requirements

### Requirement: A new ticket is announced with a sound

The kitchen screen SHALL play a short sound when a ticket appears that the screen has not shown
before. The tickets already on screen when it loads SHALL NOT sound, and a ticket that is
delivered again (the same round) SHALL NOT sound a second time. When several new tickets arrive
in the same refresh, the screen SHALL sound once.

Because browsers allow sound only after someone interacts with the page, the screen SHALL show a
sound control that says whether sound is on. Until staff tap it (or anywhere on the page), the
control SHALL say that sound is off and how to turn it on. Staff SHALL be able to mute and unmute
it; the choice SHALL be remembered on that device across reloads, and a muted screen SHALL stay
silent.

#### Scenario: A new order arrives

- **WHEN** sound is on and a round is dispatched to the kitchen
- **THEN** its ticket appears and the screen plays the sound once

#### Scenario: Opening the screen with orders already waiting

- **WHEN** the kitchen screen loads while three tickets are already in the queue
- **THEN** no sound plays

#### Scenario: The same order delivered twice

- **WHEN** a ticket already on screen is delivered again for the same round
- **THEN** no sound plays

#### Scenario: Muted

- **WHEN** staff have muted the screen and a new ticket arrives
- **THEN** the ticket appears and no sound plays
- **AND** after a reload the screen is still muted

#### Scenario: Sound not yet allowed by the browser

- **WHEN** the screen has just loaded and nobody has tapped it
- **THEN** the sound control says sound is off and to tap to turn it on
