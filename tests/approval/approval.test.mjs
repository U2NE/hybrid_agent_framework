import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalError,
  USER_APPROVAL_SCHEMA,
  approvalReceiptHash,
  createUserApprovalReceipt,
  validateUserApprovalReceipt,
} from '../../core/approval/index.mjs';

const subject = {
  runId: 'run-approval',
  specHash: 'a'.repeat(64),
  planHash: 'b'.repeat(64),
};

test('user approval receipt is deterministic for the same explicit approval event', () => {
  const input = {
    ...subject,
    approvalId: 'approval-1',
    approvedBy: 'user',
    approvedAt: '2026-09-26T00:00:00+09:00',
  };
  const first = createUserApprovalReceipt(input);
  const second = createUserApprovalReceipt(input);

  assert.equal(first.schema, USER_APPROVAL_SCHEMA);
  assert.deepEqual(first, second);
  assert.equal(first.receiptHash, approvalReceiptHash(first));
  assert.equal(validateUserApprovalReceipt(first, subject), true);
});

test('approval receipt rejects non-user approvers and malformed subject hashes', () => {
  assert.throws(
    () => createUserApprovalReceipt({
      ...subject,
      approvalId: 'approval-agent',
      approvedBy: 'lead',
      approvedAt: '2026-09-26T00:00:00Z',
    }),
    (error) => error instanceof ApprovalError && error.code === 'INVALID_APPROVER'
  );

  assert.throws(
    () => createUserApprovalReceipt({
      ...subject,
      planHash: 'not-a-hash',
      approvalId: 'approval-bad-hash',
      approvedAt: '2026-09-26T00:00:00Z',
    }),
    (error) =>
      error instanceof ApprovalError &&
      error.code === 'INVALID_APPROVAL_SUBJECT_HASH'
  );
});

test('approval receipt validation detects mutation and subject replay', () => {
  const receipt = createUserApprovalReceipt({
    ...subject,
    approvalId: 'approval-2',
    approvedBy: 'user',
    approvedAt: '2026-09-26T00:00:00Z',
  });

  const mutated = structuredClone(receipt);
  mutated.approvalId = 'approval-3';
  assert.throws(
    () => validateUserApprovalReceipt(mutated),
    (error) =>
      error instanceof ApprovalError &&
      error.code === 'INVALID_APPROVAL_RECEIPT'
  );

  assert.throws(
    () => validateUserApprovalReceipt(receipt, {
      ...subject,
      planHash: 'c'.repeat(64),
    }),
    (error) =>
      error instanceof ApprovalError &&
      error.code === 'APPROVAL_SUBJECT_MISMATCH' &&
      error.details.mismatches.some((item) => item.field === 'planHash')
  );
});
