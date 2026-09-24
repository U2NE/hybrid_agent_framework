# ADR-004: Explicit state schema v1

Status: Accepted

## Decision

Canonical state uses document marker `hybrid-state:v1`, machine field `schema: "hybrid-state/v1"`, and `schemaVersion: 1`.

Backward compatibility is limited to older v1 state that has the v1 document marker and schemaVersion 1 but omitted the string schema field.

Unsupported schema/version and corrupt JSON fail closed. They are never silently normalized/reset.
