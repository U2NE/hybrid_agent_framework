---
name: review
description: Run independent testing, context-sensitive review, conditional Sol security reasoning, and final verification with a bounded fix loop.
---

# Review

Run independent lanes against the integrated implementation snapshot when the task's existing tier/risk gates require them:

Tester + Code Reviewer + conditional Security Reviewer → Verifier

Tier 0 remains implementer → lightweight verification. Ordinary Tier 1 remains implementer → verifier. The existence of evidence/QE/repair helpers does not add routine QA fan-out.

Model routing:
- Tester and routine Verifier use Luna.
- Routine Code Reviewer uses Luna.
- Difficult/architectural/security-sensitive review raises Luna effort first; only exceptional unresolved reasoning escalates to Sol.
- Bounded Security Reviewer work uses Luna max; complex exploit/trust-boundary reasoning may escalate to Sol.
- Verification failure raises Luna effort first; repeated failure only enters Sol after Luna max is insufficient.
- A later routine stage downshifts to Luna because routing is recomputed per stage.

Rules:
- The implementer cannot final-verify its own work.
- Security activation uses strong trust-boundary triggers plus context-aware weak hints; words such as "network", "secret", or "permission" in docs/labels alone are not sufficient.
- Code review checks SPEC compliance and correctness/error/edge/regression evidence before maintainability/style.
- Security review applies the relevant auth/authz/validation/injection/XSS/SSRF/crypto/secrets/upload/payment/dependency/config checks and prioritizes severity × exploitability × blast radius.
- Final verification requires fresh test evidence, build/type/lint where applicable, original SPEC goal alignment, and a VERIFIED/PARTIAL/MISSING row for every acceptance criterion. PARTIAL or MISSING blocks PASS.
- Distinguish FIX_REQUIRED from PROOF_GAP. Blocking correctness/acceptance defects return to the implementation owner with a bounded targeted repair packet; low/style nits do not auto-repair. Stop after 3 failed repair cycles and reuse the existing failure-driven model escalation.
- A proof gap does not create a QE agent. `runQualityClosure()` acquires the cheapest semantically adequate proof (existing/focused deterministic command, CLI/process, HTTP, then browser only when required and available). Acquisition success is only `ACQUIRED`; the raw evidence stays unverified until the Verifier consumes its exact `evidenceId` and returns the semantic assessment. UI change alone never forces browser execution.
- For Tier 2/3, full-tier independent completion requires one final Verifier result that explicitly covers every required AC on the current integrated snapshot, or equivalent criterion-level independent verified evidence for every AC. One independent AC cannot satisfy the whole trace; pre-repair snapshot evidence cannot verify the repaired snapshot.
- If a required browser/runtime provider is unavailable, keep the criterion unverified rather than fabricating evidence.
- Context cache, proof selection, and passive observability add no agent/model calls.
- If an explicit routed model/effort is rejected or unavailable, fail closed; never retry without the override and never inherit the Codex session/default model.
- `runQualityClosure()` automatically constructs the default Lead decision writer and Lead orchestration event writer when callers do not inject test/custom loggers; repair/proof/completion choices therefore persist best-effort on the normal installed path.
- Review bounded decision provenance against actual runtime events and worker artifacts with the deterministic audit. Treat reported attribution as reported; never upgrade it to observed.
- Keep audit findings passive by default. Review facts, stable policy identifiers, action links, and evidence references; never store hidden reasoning, scratchpads, prompts, conversations, source text, or diffs.
