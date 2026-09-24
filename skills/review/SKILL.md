---
name: review
description: Run independent testing, context-sensitive review, conditional Sol security reasoning, and final verification with a bounded fix loop.
---

# Review

Run independent lanes after implementation:

Tester → Code Reviewer → conditional Security Reviewer → Verifier

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
- Verification failure may enter the targeted fix loop. Stop after 3 failed fix iterations and mark blocked/failed with evidence.
- If an explicit model override is rejected/unavailable, retry without model/reasoning override and record session-inheritance fallback.
