# Orbit — Solana wallet platform

A runnable foundation for a Solana-only wallet operations product. Includes a responsive developer dashboard, API and small JavaScript client, encrypted local wallets, per-wallet payment policies, human approvals, atomic budget reservations, idempotent payment requests, and an audit log.

## Run

Requires Node.js 24 or newer (uses built-in SQLite and Web Crypto).

```sh
npm install
npm start
```

Open **http://localhost:4310**. The server binds to `127.0.0.1` only. Opening the dashboard establishes a local operator session; this is intentionally a local development tool, not a hosted authentication system.

### Sandbox (default)

Create two wallets in the dashboard. Each starts with **10 simulated SOL**. Send `0.05` SOL from one to the other to exercise the local ledger, then send `0.5` SOL to exercise the approval inbox. Sandbox activity never broadcasts a blockchain transaction. Addresses are real Solana addresses backed by encrypted local keys; sandbox balances are not on-chain balances.

### Solana devnet

Stop the sandbox server, then run:

```sh
NETWORK=devnet npm start
```

Create a new wallet and fund its address with devnet SOL using <https://faucet.solana.com>. Refresh the wallet balance, then request a SOL payment. The server creates and signs a versioned transaction using the official `@solana/kit` and System Program libraries, simulates it, persists its signed bytes and signature, and attempts broadcast. Use **Payments → View → Check confirmation** to reconcile until finalized.

Only the public Solana devnet RPC is used. Mainnet is rejected. Devnet fees need additional balance beyond the transfer amount. Fees do not count toward the payment budget in this prototype. Internal notes are not on-chain memos. Devnet and sandbox use separate databases and keys.

## Policies and payment lifecycle

Defaults: 2 SOL daily budget, 1 SOL per-payment maximum, human approval above 0.1 SOL, unrestricted recipients. Policies support recipient allowlists and pausing. Amounts are decimal strings converted to integer lamports; no floating-point monetary arithmetic.

- Pending requests reserve budget inside a SQLite `BEGIN IMMEDIATE` transaction. Concurrent requests cannot each claim the same remaining budget.
- Pending, ready, preparing, and submitted requests remain reserved across midnight UTC. Completed payments count on their UTC completion day. This is conservative when a transaction finalizes late.
- Approval rechecks hard limits and current policy. Policies are checked again after asynchronous preparation before broadcast. Approval cannot override a paused wallet, recipient restriction, or budget.
- Idempotency keys must be stable per business operation. Reusing a key returns the original result; changing the payload returns HTTP 409. A new key is a new request.
- Signed bytes are persisted before broadcast. A network timeout leaves the request `submitted`, with its budget reserved. Retrying the same request cannot send a fresh transaction.
- Confirmation is manual in this version. A submitted transaction that never lands remains reserved; expiry reconciliation and safe rebroadcast are follow-up work. Never manually release a reservation based only on an RPC timeout.
- Restart resets interrupted preparation to `ready`; use **Retry preparation**. Run a single server process per database.

## API and client

The local operator bearer token lives at `.data/<network>/api-token` (not printed by the server). Load it server-side as `ORBIT_API_TOKEN`; do not put it into frontend builds.

```js
import { OrbitClient } from './src/client.js';

const client = new OrbitClient({ token: process.env.ORBIT_API_TOKEN });
const wallet = await client.createWallet('Payout agent');
const payment = await client.requestPayment({
  walletId: wallet.id,
  recipient: 'RECIPIENT_SOLANA_ADDRESS',
  amount: '0.05',
  memo: 'Contributor payout',
}, 'unique-business-operation-id');
```

| Endpoint | Purpose |
| --- | --- |
| `GET /api/state` | Wallets, latest 200 payments plus all outstanding payments, latest 100 audit events |
| `POST /api/wallets` | Create wallet: `{ name }` |
| `GET /api/wallets/:id/balance` | Fetch sandbox or live devnet balance in lamports |
| `PATCH /api/wallets/:id/policy` | `{ daily, perTransfer, approvalAbove, allowlist, paused }`; amounts are SOL strings |
| `POST /api/payments` | `{ walletId, recipient, amount, memo? }`, required `Idempotency-Key` header |
| `POST /api/payments/:id/decision` | `{ decision: "approve" \| "reject" }` |
| `POST /api/payments/:id/execute` | Retry interrupted preparation of a `ready` payment |
| `POST /api/payments/:id/reconcile` | Check persisted devnet signature for finalization |

Responses omit private keys, encrypted key envelopes, and signed transaction bytes. Browser writes require a same-origin session; server clients use a bearer token. Unknown/invalid requests return JSON errors.

## Key management boundary

`src/vault.js` stores wallet seeds under AES-256-GCM with wallet-ID associated data. The randomly generated master key and database are stored in the network's `.data` directory with restrictive local permissions. Seeds are wiped from temporary buffers after use, although JavaScript/Web Crypto cannot guarantee complete memory erasure.

This is **server-controlled, local development custody**. It is not a TEE, MPC, a managed key provider, or user self-custody. The same local operator can edit policy and approve payments. Anyone with the database and master key can decrypt wallets. There is no private-key export route. Back up the database and master key together securely; losing the key loses access. Do not fund these wallets with real assets.

The signer boundary is in `src/solana.js`; replace local decryption/signing with a managed signer before supporting real funds. Before hosting: implement tenant isolation, end-user authentication, scoped application credentials, independent approver roles, signing policy enforcement outside the web app, key recovery, rate limits, and security review. The local audit table is not tamper-evident.

## Verification

```sh
npm test
npm run check
npm run test:e2e
```

Browser tests use Google Chrome and an isolated temporary database on port 4311. Install Chrome or change the Playwright browser configuration. Tests cover amounts, authenticated encryption, reservations under concurrency, UTC rollover, duplicate requests, approval rechecks, broadcast uncertainty, real transaction signatures with mocked RPC, HTTP protections, and the complete browser workflow at desktop/mobile widths.

No live funded devnet transfer is required by the tests. Screenshots are written to `.artifacts/`.

## Next milestones

1. SPL token / devnet USDC support with exact mint, token-program, decimals, associated token account, rent, and fee validation.
2. Managed signing provider, user login and wallet recovery, tenant-scoped app credentials and separate approvers.
3. Background finalization, expiry resolution, webhook delivery and paginated API queries.
4. Agent-scoped budgets and expiring permissions, cumulative organization limits, policy audit exports.

Official Solana references: <https://solana.com/docs/frontend/client> and <https://github.com/anza-xyz/kit>.
