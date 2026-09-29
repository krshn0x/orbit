import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { getTransactionDecoder, getBase64Encoder } from '@solana/kit';
import { openStore } from '../src/store.js';
import { LocalVault } from '../src/vault.js';
import { WalletService } from '../src/service.js';
import { toLamports } from '../src/policy.js';
import { DevnetProvider, generateWallet } from '../src/solana.js';
import { createApp } from '../src/server.js';

async function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-test-'));
  const db = openStore(':memory:');
  const vault = new LocalVault(join(directory, 'key'));
  const service = new WalletService(db, vault, options);
  const wallet = await service.createWallet({ name: 'Test wallet' });
  const recipient = (await service.createWallet({ name: 'Recipient' })).address;
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, service, wallet, recipient, vault, directory };
}
const policy = (overrides = {}) => ({ daily: '2', perTransfer: '1', approvalAbove: '0.1', allowlist: [], paused: false, ...overrides });
const pay = (s, wallet, recipient, amount, key = randomUUID()) => s.requestPayment({ walletId: wallet.id, recipient, amount }, key);

test('SOL amounts use exact lamports and reject floats, exponent notation and excess precision', () => {
  assert.equal(toLamports('0.000000001'), 1);
  assert.equal(toLamports('1.234567891'), 1234567891);
  for (const input of ['1e3', '-1', '0', '0.0000000001', 'NaN', '01', 0.1, '1000001']) assert.throws(() => toLamports(input));
});
test('key ciphertext is authenticated and bound to its wallet; public responses omit key material', async t => {
  const { service, db, wallet, vault, directory } = await setup(t);
  const row = db.prepare('SELECT * FROM wallets WHERE id=?').get(wallet.id);
  const seed = vault.decrypt(row.encrypted_key, wallet.id);
  assert.equal(seed.length, 32);
  assert.equal(JSON.stringify(service.snapshot()).includes(row.encrypted_key), false);
  assert.throws(() => vault.decrypt(row.encrypted_key, 'other-wallet'));
  const altered = Buffer.from(row.encrypted_key, 'base64'); altered[30] ^= 1;
  assert.throws(() => vault.decrypt(altered.toString('base64'), wallet.id));
  assert.equal(readFileSync(join(directory, 'key')).length, 32);
  assert.throws(() => new LocalVault(join(directory, 'missing'), true), /Master key missing/);
  seed.fill(0);
});
test('sandbox debit, internal credit, idempotency and changed-payload rejection', async t => {
  const { service, wallet, recipient } = await setup(t);
  const p = await pay(service, wallet, recipient, '0.05', 'invoice-1');
  assert.equal(p.status, 'simulated'); assert.equal(p.signature, null);
  assert.equal(service.publicWallet(wallet.id).balance, 9950000000);
  assert.equal(service.snapshot().wallets.find(w => w.address === recipient).balance, 10050000000);
  assert.equal((await pay(service, wallet, recipient, '0.05', 'invoice-1')).id, p.id);
  assert.equal(service.publicWallet(wallet.id).balance, 9950000000);
  await assert.rejects(() => pay(service, wallet, recipient, '0.06', 'invoice-1'), /different payment/);
});
test('concurrent pending requests reserve budget and rejection releases it', async t => {
  const { service, wallet, recipient } = await setup(t);
  const results = await Promise.all([pay(service, wallet, recipient, '0.8'), pay(service, wallet, recipient, '0.8'), pay(service, wallet, recipient, '0.8')]);
  assert.deepEqual(results.map(p => p.status), ['pending', 'pending', 'denied']);
  assert.equal(service.committed(wallet.id), 1600000000);
  await service.decide(results[0].id, 'reject');
  assert.equal(service.committed(wallet.id), 800000000);
  assert.equal((await pay(service, wallet, recipient, '0.8')).status, 'pending');
});
test('approval checks current policy, rejects paused wallets and cannot execute twice', async t => {
  const { service, wallet, recipient } = await setup(t);
  const p = await pay(service, wallet, recipient, '0.5');
  service.updatePolicy(wallet.id, policy({ paused: true }));
  assert.equal((await service.decide(p.id, 'approve')).status, 'denied');
  service.updatePolicy(wallet.id, policy());
  const next = await pay(service, wallet, recipient, '0.5');
  assert.equal((await service.decide(next.id, 'approve')).status, 'simulated');
  await assert.rejects(() => service.decide(next.id, 'approve'), /Only pending/);
  await assert.rejects(() => service.execute(next.id), /not ready/);
  assert.equal(service.publicWallet(wallet.id).balance, 9500000000);
});
test('allowlist, per-payment limits, self-transfers and policy validation', async t => {
  const { service, wallet, recipient } = await setup(t);
  service.updatePolicy(wallet.id, policy({ allowlist: [wallet.address] }));
  assert.equal((await pay(service, wallet, recipient, '0.05')).status, 'denied');
  service.updatePolicy(wallet.id, policy());
  assert.equal((await pay(service, wallet, recipient, '1.1')).status, 'denied');
  await assert.rejects(() => pay(service, wallet, wallet.address, '0.1'), /other than/);
  await assert.rejects(() => pay(service, wallet, 'invalid', '0.1'), /valid Solana/);
  assert.throws(() => service.updatePolicy(wallet.id, policy({ daily: '0.1' })), /threshold/);
});
test('pending reservations survive UTC rollover while previous-day completed payments do not', async t => {
  const { service, db, wallet, recipient } = await setup(t);
  const pending = await pay(service, wallet, recipient, '0.5');
  const completed = await pay(service, wallet, recipient, '0.05');
  db.prepare("UPDATE payments SET created_at='2020-01-01T00:00:00Z', updated_at='2020-01-01T00:00:00Z' WHERE id IN (?,?)").run(pending.id, completed.id);
  assert.equal(service.committed(wallet.id), 500000000);
});
test('old pending approvals remain visible beyond the recent-payment history limit', async t => {
  const { service, db, wallet, recipient } = await setup(t);
  const pending = await pay(service, wallet, recipient, '0.5');
  db.prepare("UPDATE payments SET created_at='2020-01-01T00:00:00Z' WHERE id=?").run(pending.id);
  for (let i = 0; i < 201; i++) await pay(service, wallet, recipient, '1.1');
  assert.equal(service.snapshot().payments.some(p => p.id === pending.id), true);
  assert.equal(service.snapshot().payments.length, 201);
});
test('broadcast uncertainty preserves signed bytes and budget; idempotent retry cannot broadcast again', async t => {
  let broadcasts = 0;
  const provider = { prepare: async () => ({ wire: 'signed-wire', signature: 'signature', lastValidHeight: '123' }), broadcast: async () => { broadcasts++; throw new Error('timeout'); }, status: async () => ({ err: null, confirmationStatus: 'finalized' }) };
  const { service, db, wallet, recipient } = await setup(t, { mode: 'devnet', provider });
  const p = await pay(service, wallet, recipient, '0.05', 'retry-test');
  assert.equal(p.status, 'submitted'); assert.equal(service.committed(wallet.id), 50000000);
  assert.equal(db.prepare('SELECT wire FROM payments WHERE id=?').get(p.id).wire, 'signed-wire');
  await pay(service, wallet, recipient, '0.05', 'retry-test'); assert.equal(broadcasts, 1);
  assert.equal((await service.reconcile(p.id)).status, 'confirmed');
});
test('policy pause or approval change during preparation stops broadcast', async t => {
  let unblock; let broadcasts = 0;
  const provider = { prepare: () => new Promise(resolve => { unblock = () => resolve({ wire: 'wire', signature: 'sig', lastValidHeight: '1' }); }), broadcast: async () => { broadcasts++; } };
  const { service, wallet, recipient } = await setup(t, { mode: 'devnet', provider });
  const request = pay(service, wallet, recipient, '0.05');
  service.updatePolicy(wallet.id, policy({ paused: true })); unblock();
  assert.equal((await request).status, 'denied'); assert.equal(broadcasts, 0);
  service.updatePolicy(wallet.id, policy());
  const next = pay(service, wallet, recipient, '0.05');
  service.updatePolicy(wallet.id, policy({ approvalAbove: '0' })); unblock();
  assert.equal((await next).status, 'pending'); assert.equal(broadcasts, 0);
});
test('devnet transaction uses real Ed25519 signature and a successful preflight simulation', async () => {
  const { seed, address } = await generateWallet();
  const target = await generateWallet();
  const provider = new DevnetProvider(); let simulated;
  provider.rpc = {
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 123n } }) }),
    simulateTransaction: wire => ({ send: async () => { simulated = wire; return { value: { err: null } }; } }),
  };
  const prepared = await provider.prepare(seed, target.address, 50000000);
  assert.equal(prepared.wire, simulated);
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.wire));
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  assert.equal(verify(null, transaction.messageBytes, createPublicKey(privateKey), transaction.signatures[address]), true);
  seed.fill(0); target.seed.fill(0);
});
test('HTTP API requires auth, blocks foreign origins and rejects malformed input', async t => {
  const { service } = await setup(t);
  const token = 'test-token-that-is-not-a-real-credential';
  const server = createApp({ service, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  const home = await fetch(base); assert.equal(home.status, 200);
  const cookie = home.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).status, 200);
  const headers = { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://evil.example' };
  assert.equal((await fetch(`${base}/api/wallets`, { method: 'POST', headers, body: '{"name":"Bad"}' })).status, 403);
  headers.Origin = base;
  assert.equal((await fetch(`${base}/api/wallets`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/api/wallets`, { method: 'POST', headers, body: 'null' })).status, 400);
  assert.equal((await fetch(`${base}/api/wallets`, { method: 'POST', headers, body: '{"name":"API wallet"}' })).status, 201);
  const authorized = await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).wallets.length, 3);
});
