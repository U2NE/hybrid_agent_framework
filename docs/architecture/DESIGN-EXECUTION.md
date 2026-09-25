# Design execution lane

Hybrid treats material UI design as an isolated execution lane rather than giving every frontend worker unrestricted design authority.

## Roles

- **Design Architect** is read-only. It inspects existing product constraints, design-system tokens, and the relevant UI before returning a bounded design contract.
- **Design Executor** is the only design-specific writer. It implements an approved design task inside the file leases and an exclusive `ui:<surface>` semantic resource granted by the sealed execution graph.
- **Design Reviewer** is read-only. It independently checks the integrated result against the design contract, existing design system, responsive/state/accessibility requirements, and available deterministic or browser/screenshot evidence.

The lane is conditional. Ordinary backend work does not pay for these roles.

## Parallel execution

Design Executor is a PLAN task owner, not a second candidate implementation of the same task. Hybrid does not run an Implementer and Design Executor on the same assignment and then choose a winner.

Scheduler conflict detection uses both files and semantic resources. For example:

```text
design-executor:  file src/components/Checkout.tsx
                  resource ui:checkout (exclusive)

implementer:      file src/hooks/useCheckout.ts
                  resource ui:checkout (exclusive)
```

These tasks serialize even though the files differ. If the second task instead owns `ui:profile`, and file/read-write dependencies are also disjoint, both tasks may run in the same wave. Because both are mutators, worktree isolation is still required for a parallel wave.

## Authority boundary

A Design Executor task with writes but without an exclusive `ui:<surface>` lease fails closed with `UI_LEASE_REQUIRED`. The sealed execution graph stores the role capability grant and revalidates the grant and resource lease when the graph is loaded or validated.

Design Architect and Design Reviewer cannot own mutating tasks. Product behavior, public API, schema meaning, feature scope, or security-posture changes remain material revisions and require the normal user-approval path rather than being inferred from visual design work.

## Review evidence

Design review should prefer deterministic evidence first when available: build/type/lint checks, design-system/static rules, accessibility checks, and state coverage. Browser or screenshot evidence is used when the acceptance claim is visual or responsive and cannot be established from static evidence alone. A visual review finding does not grant the reviewer write authority; repairs return to the leased Design Executor task.
