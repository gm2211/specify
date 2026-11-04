# counter Specification

## Purpose

A counter that counts up to a cap. This example shows how Specify links Quint and Lean checks to
OpenSpec requirements.

## Requirements

### Requirement: Count never goes negative

The counter SHALL never hold a value below zero.

- Formal: quint formal/Counter.qnt nonNegative main=Counter
- Formal: quint formal/Counter.qnt nonNegative main=CounterBefore expect=fails
- Formal: quint formal/Counter.qnt nonNegative main=Counter backend=apalache max-steps=8
- Formal: quint formal/Counter.qnt nonNegative main=Counter mode=simulate max-steps=8 samples=20 seed=17
- Formal: lean formal/Counter.lean Counter.incrementPreservesNonnegative

#### Scenario: Increment from zero

- **WHEN** the counter is zero and is incremented
- **THEN** it holds one

### Requirement: Count reaches the cap

The counter SHALL reach its cap when steps keep being taken.

- Formal: quint formal/Counter.qnt reachesCap temporal main=Counter
- Formal: quint formal/Counter.qnt reachesCap temporal main=CounterBefore expect=fails

#### Scenario: Repeated increments

- **WHEN** the counter is incremented three times from zero
- **THEN** it holds the cap
