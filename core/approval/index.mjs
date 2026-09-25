import { createHash } from 'node:crypto';

export const USER_APPROVAL_SCHEMA = 'hybrid-user-approval/v1';

export class ApprovalError extends Error {
  constructor(message, code = 'APPROVAL_ERROR', details = {}) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
    this.details = details;
  }
}

export function createUserApprovalReceipt(input = {}) {
  const subject = normalizeApprovalSubject(input);
  const receipt = {
    schema: USER_APPROVAL_SCHEMA,
    approvalId: safeIdentifier(input.approvalId, 'approvalId'),
    approvedBy: normalizeApprover(input.approvedBy ?? 'user'),
    approvedAt: normalizeTimestamp(input.approvedAt),
    runId: subject.runId,
    specHash: subject.specHash,
    planHash: subject.planHash,
  };
  receipt.receiptHash = approvalReceiptHash(receipt);
  return Object.freeze(receipt);
}

export function validateUserApprovalReceipt(receipt, expectedSubject = null) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new ApprovalError('approval receipt must be an object', 'INVALID_APPROVAL_RECEIPT');
  }

  const errors = [];
  if (receipt.schema !== USER_APPROVAL_SCHEMA) errors.push('invalid schema');

  let normalized;
  try {
    normalized = {
      schema: USER_APPROVAL_SCHEMA,
      approvalId: safeIdentifier(receipt.approvalId, 'approvalId'),
      approvedBy: normalizeApprover(receipt.approvedBy),
      approvedAt: normalizeTimestamp(receipt.approvedAt),
      ...normalizeApprovalSubject(receipt),
    };
  } catch (error) {
    if (error instanceof ApprovalError) errors.push(error.message);
    else throw error;
  }

  if (
    typeof receipt.receiptHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(receipt.receiptHash)
  ) {
    errors.push('invalid receiptHash');
  } else if (normalized) {
    const expectedHash = approvalReceiptHash(normalized);
    if (receipt.receiptHash !== expectedHash) errors.push('receipt hash mismatch');
  }

  if (errors.length) {
    throw new ApprovalError(
      'approval receipt validation failed: ' + errors.join('; '),
      'INVALID_APPROVAL_RECEIPT',
      { errors }
    );
  }

  if (expectedSubject) {
    const expected = normalizeApprovalSubject(expectedSubject);
    const mismatches = [];
    for (const field of ['runId', 'specHash', 'planHash']) {
      if (normalized[field] !== expected[field]) {
        mismatches.push({
          field,
          expected: expected[field],
          actual: normalized[field],
        });
      }
    }
    if (mismatches.length) {
      throw new ApprovalError(
        'approval receipt does not match the execution subject',
        'APPROVAL_SUBJECT_MISMATCH',
        { mismatches }
      );
    }
  }

  return true;
}

export function approvalReceiptHash(receipt) {
  const copy = {
    schema: receipt.schema,
    approvalId: receipt.approvalId,
    approvedBy: receipt.approvedBy,
    approvedAt: receipt.approvedAt,
    runId: receipt.runId,
    specHash: receipt.specHash,
    planHash: receipt.planHash,
  };
  return sha256(canonical(copy));
}

export function normalizeApprovalSubject(input = {}) {
  return {
    runId: requiredString(input.runId, 'runId'),
    specHash: sha256String(input.specHash, 'specHash'),
    planHash: sha256String(input.planHash, 'planHash'),
  };
}

function normalizeApprover(value) {
  const approver = String(value ?? '').trim();
  if (approver !== 'user') {
    throw new ApprovalError(
      'approvedBy must be exactly "user"',
      'INVALID_APPROVER',
      { approvedBy: approver || null }
    );
  }
  return approver;
}

function normalizeTimestamp(value) {
  const text = requiredString(value, 'approvedAt');
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    throw new ApprovalError('approvedAt must be an ISO-compatible timestamp', 'INVALID_APPROVAL_TIMESTAMP');
  }
  return new Date(milliseconds).toISOString();
}

function safeIdentifier(value, field) {
  const text = requiredString(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    throw new ApprovalError(
      field + ' contains an unsafe identifier',
      'INVALID_APPROVAL_IDENTIFIER',
      { field }
    );
  }
  return text;
}

function sha256String(value, field) {
  const text = requiredString(value, field);
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new ApprovalError(
      field + ' must be a sha256 hex digest',
      'INVALID_APPROVAL_SUBJECT_HASH',
      { field }
    );
  }
  return text;
}

function requiredString(value, field) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new ApprovalError(field + ' is required', 'MISSING_APPROVAL_FIELD', { field });
  }
  return text;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(
      (key) => JSON.stringify(key) + ':' + canonical(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}
