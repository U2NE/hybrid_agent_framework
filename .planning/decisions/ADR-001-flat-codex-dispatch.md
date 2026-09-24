# ADR-001: Flat Codex Dispatch

## Status
Accepted

## Decision
Use a lead plus sibling specialist agents. Do not make recursive agent trees the default.

## Rationale
The pinned GSD Codex adapter explicitly emits a bare agents table with max_depth = 1 and standalone agent TOMLs. Artifact handoffs are therefore the stable composition mechanism.

## Consequences
- Roles communicate through files.
- Lead remains thin.
- Nested delegation may be added only as an explicit future capability.
