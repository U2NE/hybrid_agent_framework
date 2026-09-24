# ADR-002: .planning Is Canonical

## Status
Accepted

## Decision
All authoritative project state is stored under .planning/. The wiki is derived.

## Rationale
Two writable sources of truth create divergence and recovery ambiguity.

## Consequences
- STATE.md corruption fails closed.
- Wiki can be deleted and rebuilt without losing project authority.
