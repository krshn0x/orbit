export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function toLamports(value, { allowZero = false } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,6})(\.\d{1,9})?$/.test(value)) {
    throw new AppError('Use a decimal SOL string with at most 9 decimal places.');
  }
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
  if (amount > 1_000_000_000_000_000n || amount < (allowZero ? 0n : 1n)) {
    throw new AppError('Amount must be positive and no more than 1,000,000 SOL.');
  }
  return Number(amount);
}

export function evaluate(policy, amount, recipient, committed, humanApproved = false) {
  if (policy.paused) return { status: 'denied', reason: 'Wallet payments are paused.' };
  if (policy.allowlist.length && !policy.allowlist.includes(recipient)) {
    return { status: 'denied', reason: 'Recipient is not on the allowlist.' };
  }
  if (amount > policy.perTransfer) return { status: 'denied', reason: 'Per-payment limit exceeded.' };
  if (committed + amount > policy.daily) return { status: 'denied', reason: 'Daily budget exhausted, including reserved payments.' };
  if (!humanApproved && amount > policy.approvalAbove) {
    return { status: 'pending', reason: 'Human approval required; budget reserved.' };
  }
  return { status: 'ready', reason: humanApproved ? 'Approved by the local operator.' : 'Within automatic payment limits.' };
}
