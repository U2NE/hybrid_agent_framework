import { createUserApprovalReceipt } from '../../core/approval/index.mjs';
import {
  executionApprovalSubject,
  sealExecutionPlan,
} from '../../core/execution-graph/index.mjs';

export function testApprovalReceipt(plan, options = {}) {
  const subject = executionApprovalSubject(plan, options);
  return createUserApprovalReceipt({
    ...subject,
    approvalId: options.approvalId || 'test-approval',
    approvedBy: 'user',
    approvedAt: options.approvedAt || '2026-01-01T00:00:00.000Z',
  });
}

export function sealApprovedExecutionPlan(plan, options = {}) {
  const approvalReceipt =
    options.approvalReceipt ||
    testApprovalReceipt(plan, options);
  return sealExecutionPlan(plan, {
    ...options,
    approvalReceipt,
  });
}
