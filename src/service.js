import { randomUUID, createHash } from 'node:crypto';
import { atomic } from './store.js';
import { AppError, toLamports, evaluate } from './policy.js';
import { generateWallet, validateAddress } from './solana.js';

const now = () => new Date().toISOString();
const defaultPolicy = { daily: 2_000_000_000, perTransfer: 1_000_000_000, approvalAbove: 100_000_000, allowlist: [], paused: false };
const text = (value, max, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(`${name} must contain 1–${max} characters.`);
  return value.trim();
};
function checkedAddress(value) {
  try { return validateAddress(value); } catch { throw new AppError('Enter a valid Solana address.'); }
}

export class WalletService {
  constructor(db, vault, { mode = 'sandbox', provider = null } = {}) {
    if (!['sandbox', 'devnet'].includes(mode)) throw new Error('Only sandbox and devnet are supported.');
    this.db = db; this.vault = vault; this.mode = mode; this.provider = provider;
    // No transaction was persisted/broadcast in preparing. The signing step can be retried safely.
    db.prepare("UPDATE payments SET status='ready', reason='Preparation interrupted; retry execution.' WHERE status='preparing'").run();
  }
  audit(action, id, detail) {
    this.db.prepare('INSERT INTO audit(action,resource_id,detail,created_at) VALUES(?,?,?,?)').run(action, id, detail, now());
  }
  wallet(id) {
    const wallet = this.db.prepare('SELECT * FROM wallets WHERE id=?').get(id);
    if (!wallet) throw new AppError('Wallet not found.', 404);
    return { ...wallet, policy: JSON.parse(wallet.policy) };
  }
  committed(id, exclude = '') {
    return this.db.prepare(`SELECT COALESCE(SUM(amount),0) AS amount FROM payments
      WHERE wallet_id=? AND id != ? AND (
        status IN ('pending','ready','preparing','submitted') OR
        (status IN ('simulated','confirmed') AND updated_at >= ?))`).get(id, exclude, `${now().slice(0, 10)}T00:00:00.000Z`).amount;
  }
  publicWallet(id) {
    const { encrypted_key, ...wallet } = this.wallet(id);
    return { ...wallet, committed: this.committed(id) };
  }
  payment(id) {
    const row = this.db.prepare('SELECT * FROM payments WHERE id=?').get(id);
    if (!row) throw new AppError('Payment not found.', 404);
    const { wire, fingerprint, idempotency_key, ...payment } = row;
    return payment;
  }
  snapshot() {
    return {
      mode: this.mode,
      wallets: this.db.prepare('SELECT id FROM wallets ORDER BY created_at DESC').all().map(w => this.publicWallet(w.id)),
      payments: this.db.prepare(`SELECT id FROM payments
        WHERE id IN (SELECT id FROM payments ORDER BY created_at DESC LIMIT 200)
        OR status IN ('pending','ready','preparing','submitted')
        ORDER BY created_at DESC`).all().map(p => this.payment(p.id)),
      audit: this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all(),
    };
  }
  async createWallet(input) {
    const name = text(input.name, 60, 'Wallet name');
    const id = randomUUID();
    const { address, seed } = await generateWallet();
    try {
      const encrypted = this.vault.encrypt(seed, id);
      atomic(this.db, () => {
        this.db.prepare('INSERT INTO wallets VALUES(?,?,?,?,?,?,?)').run(id, name, address, encrypted, this.mode === 'sandbox' ? 10_000_000_000 : 0, JSON.stringify(defaultPolicy), now());
        this.audit('wallet.created', id, `${name} · ${this.mode} · local encrypted signer`);
      });
      return this.publicWallet(id);
    } finally { seed.fill(0); }
  }
  updatePolicy(id, input) {
    this.wallet(id);
    if (!Array.isArray(input.allowlist) || input.allowlist.length > 100 || typeof input.paused !== 'boolean') throw new AppError('Provide an address allowlist and a boolean paused value.');
    const policy = {
      daily: toLamports(input.daily), perTransfer: toLamports(input.perTransfer),
      approvalAbove: toLamports(input.approvalAbove, { allowZero: true }),
      allowlist: [...new Set(input.allowlist.map(checkedAddress))], paused: input.paused,
    };
    if (policy.perTransfer > policy.daily || policy.approvalAbove > policy.perTransfer) throw new AppError('Approval threshold must be ≤ per-payment limit ≤ daily budget.');
    atomic(this.db, () => {
      this.db.prepare('UPDATE wallets SET policy=? WHERE id=?').run(JSON.stringify(policy), id);
      this.audit('policy.updated', id, JSON.stringify(policy));
    });
    return this.publicWallet(id);
  }
  async requestPayment(input, idempotencyKey) {
    const key = text(idempotencyKey, 100, 'Idempotency-Key');
    const walletId = text(input.walletId, 100, 'Wallet ID');
    const recipient = checkedAddress(input.recipient);
    const amount = toLamports(input.amount);
    const memo = input.memo === undefined || input.memo === '' ? '' : text(input.memo, 180, 'Note');
    const fingerprint = createHash('sha256').update(JSON.stringify({ walletId, recipient, amount, memo })).digest('hex');
    const result = atomic(this.db, () => {
      const existing = this.db.prepare('SELECT id,fingerprint FROM payments WHERE idempotency_key=?').get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new AppError('Idempotency key was already used for a different payment.', 409);
        return { id: existing.id, existing: true };
      }
      const wallet = this.wallet(walletId);
      if (wallet.address === recipient) throw new AppError('Choose a recipient other than the source wallet.');
      const result = evaluate(wallet.policy, amount, recipient, this.committed(walletId));
      const id = randomUUID(); const timestamp = now();
      this.db.prepare(`INSERT INTO payments(id,wallet_id,recipient,amount,memo,status,reason,idempotency_key,fingerprint,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, walletId, recipient, amount, memo, result.status, result.reason, key, fingerprint, timestamp, timestamp);
      this.audit(`payment.${result.status}`, id, result.reason);
      return { id, existing: false };
    });
    if (!result.existing && this.payment(result.id).status === 'ready') await this.execute(result.id);
    return this.payment(result.id);
  }
  changeStatus(id, status, reason, extra = {}) {
    this.db.prepare('UPDATE payments SET status=?,reason=?,updated_at=? WHERE id=?').run(status, reason, now(), id);
    if (extra.signature) this.db.prepare('UPDATE payments SET signature=?,wire=?,last_valid_height=? WHERE id=?').run(extra.signature, extra.wire, extra.lastValidHeight, id);
    this.audit(`payment.${status}`, id, reason);
  }
  async decide(id, decision) {
    if (!['approve', 'reject'].includes(decision)) throw new AppError('Decision must be approve or reject.');
    atomic(this.db, () => {
      const payment = this.payment(id);
      if (payment.status !== 'pending') throw new AppError('Only pending payments can be reviewed.', 409);
      if (decision === 'reject') { this.changeStatus(id, 'rejected', 'Rejected by the local operator.'); return; }
      const wallet = this.wallet(payment.wallet_id);
      const result = evaluate(wallet.policy, payment.amount, payment.recipient, this.committed(wallet.id, id), true);
      this.db.prepare('UPDATE payments SET human_approved=1 WHERE id=?').run(id);
      this.changeStatus(id, result.status, result.reason);
    });
    if (this.payment(id).status === 'ready') await this.execute(id);
    return this.payment(id);
  }
  async execute(id) {
    const canExecute = atomic(this.db, () => {
      const payment = this.payment(id);
      if (payment.status !== 'ready') throw new AppError('Payment is not ready for execution.', 409);
      const wallet = this.wallet(payment.wallet_id);
      const result = evaluate(wallet.policy, payment.amount, payment.recipient, this.committed(wallet.id, id), Boolean(payment.human_approved));
      if (result.status !== 'ready') { this.changeStatus(id, result.status, result.reason); return false; }
      if (this.mode === 'sandbox') {
        if (wallet.balance < payment.amount) { this.changeStatus(id, 'failed', 'Insufficient sandbox balance.'); return false; }
        this.db.prepare('UPDATE wallets SET balance=balance-? WHERE id=?').run(payment.amount, wallet.id);
        this.db.prepare('UPDATE wallets SET balance=balance+? WHERE address=?').run(payment.amount, payment.recipient);
        this.changeStatus(id, 'simulated', 'Sandbox ledger updated. No blockchain transaction was sent.');
        return false;
      }
      this.changeStatus(id, 'preparing', 'Preparing and simulating a devnet SOL transfer.');
      return true;
    });
    if (!canExecute) return this.payment(id);
    const payment = this.payment(id);
    let prepared;
    try {
      const wallet = this.wallet(payment.wallet_id);
      const seed = this.vault.decrypt(wallet.encrypted_key, wallet.id);
      try { prepared = await this.provider.prepare(seed, payment.recipient, payment.amount); }
      finally { seed.fill(0); }
    } catch {
      atomic(this.db, () => this.changeStatus(id, 'failed', 'Preparation failed before broadcast. Check devnet funding, fees, and RPC availability.'));
      return this.payment(id);
    }
    // Recheck after asynchronous RPC work; pause/allowlist changes must take effect before broadcast.
    const allowed = atomic(this.db, () => {
      const wallet = this.wallet(payment.wallet_id);
      const result = evaluate(wallet.policy, payment.amount, payment.recipient, this.committed(wallet.id, id), Boolean(payment.human_approved));
      if (result.status !== 'ready') { this.changeStatus(id, result.status, result.reason); return false; }
      // Persist signed bytes and signature BEFORE broadcasting. An RPC timeout must never trigger a fresh transfer.
      this.changeStatus(id, 'submitted', 'Awaiting devnet confirmation. Budget remains reserved.', prepared);
      return true;
    });
    if (allowed) {
      try { await this.provider.broadcast(prepared.wire); }
      catch { this.audit('payment.broadcast_uncertain', id, 'RPC did not acknowledge broadcast; retain reservation and reconcile the stored signature.'); }
    }
    return this.payment(id);
  }
  async reconcile(id) {
    const payment = this.payment(id);
    if (this.mode !== 'devnet' || payment.status !== 'submitted') throw new AppError('Only submitted devnet payments can be checked.', 409);
    let status;
    try { status = await this.provider.status(payment.signature); }
    catch { throw new AppError('Devnet RPC unavailable. Payment remains reserved; retry the status check.', 502); }
    atomic(this.db, () => {
      if (this.payment(id).status !== 'submitted') return;
      if (status?.err) this.changeStatus(id, 'failed', 'Transaction failed on devnet.');
      else if (status?.confirmationStatus === 'finalized') this.changeStatus(id, 'confirmed', 'Finalized on Solana devnet.');
    });
    return this.payment(id);
  }
}
