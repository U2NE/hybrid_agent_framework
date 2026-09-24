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
- Difficult/architectural/security-sensitive Code Reviewer work escalates to Sol.
- Security Reviewer uses Sol.
- After repeated verification failure, the next difficult debugging/review/verifier judgment may escalate to Sol.
- A later routine stage downshifts to Luna because routing is recomputed per stage.

Rules:
- The implementer cannot final-verify its own work.
- Activate security review when authentication, authorization, crypto, secrets, payments, file upload, SQL, network trust, or permissions change.
- Verification failure may enter a targeted fix loop.
- Stop after 3 failed fix iterations and mark the work blocked or failed with evidence.
- If an explicit model override is rejected/unavailable, retry without model/reasoning override and record session-inheritance fallback.
