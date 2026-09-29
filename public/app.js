const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sol = value => (Number(value) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 9 });
const decimal = value => (Number(value) / 1e9).toFixed(9).replace(/\.?0+$/, '') || '0';
const short = value => `${value.slice(0, 5)}…${value.slice(-5)}`;
const date = value => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const badge = status => `<span class="badge ${escape(status)}">${escape(status.replaceAll('_', ' '))}</span>`;
let state = { wallets: [], payments: [], audit: [], mode: 'sandbox' };
let view = 'overview';
let toastTimer;
const balances = new Map();
const titles = { overview: 'Overview', wallets: 'Wallets', payments: 'Payments', approvals: 'Approvals', policies: 'Policies', activity: 'Activity log', developers: 'Developer guide' };
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}
function notify(message) {
  $('#toast').textContent = message; $('#toast').style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').style.display = 'none'; }, 5000);
}
async function refresh() { state = await api('/state'); render(); }
function heading(title, subtitle, action = '') {
  return `<div class="page-heading"><div><div class="eyebrow">YOUR SOLANA CONTROL CENTER</div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}
const createButton = '<button class="primary" data-action="new-wallet">＋ Create wallet</button>';
const payButton = '<button class="primary" data-action="new-payment">↗ New payment</button>';
function empty(title, description, action = '') { return `<div class="empty"><div class="empty-symbol">◈</div>${title}<p>${description}</p>${action}</div>`; }
const walletName = id => escape(state.wallets.find(w => w.id === id)?.name || id);
function paymentTable(payments) {
  if (!payments.length) return empty('Your first payment starts here', 'Create a wallet, set its policy, and send a payment request.', payButton);
  return `<div class="table-wrap"><table><thead><tr><th>Wallet / recipient</th><th>Amount</th><th>Status</th><th>Created</th><th>Details</th></tr></thead><tbody>${payments.map(p => `<tr><td>${walletName(p.wallet_id)}<span class="subtext mono">↗ ${escape(short(p.recipient))}</span></td><td>${sol(p.amount)} SOL</td><td>${badge(p.status)}</td><td>${date(p.created_at)}</td><td><button class="text-button" data-action="payment-detail" data-id="${p.id}">View ↗</button></td></tr>`).join('')}</tbody></table></div>`;
}
function overview() {
  const pending = state.payments.filter(p => p.status === 'pending');
  const completed = state.payments.filter(p => ['simulated', 'confirmed'].includes(p.status));
  const volume = completed.reduce((sum, p) => sum + p.amount, 0);
  return heading('Workspace overview', 'Wallets, payments, and permissions. All in one orbit.', createButton) + `
    <section class="hero"><div class="hero-copy"><div class="eyebrow">PURPOSE-BUILT FOR SOLANA</div><h2>Your wallets. Your rules.</h2><p>Give every payment a clear set of permissions.<br>Build confidently, one transaction at a time.</p><button class="text-button" data-view="developers">Explore the developer guide &nbsp; ↗</button></div><div class="hero-art" aria-hidden="true"><div class="solana-mark"><i></i><i></i><i></i></div></div></section>
    <div class="stats">
      <div class="stat"><div class="stat-label">Total wallets <span class="stat-icon">▣</span></div><div class="stat-value">${state.wallets.length}</div><div class="stat-note"><em>Solana</em> · encrypted local keys</div></div>
      <div class="stat"><div class="stat-label">Payment volume <span class="stat-icon">↗</span></div><div class="stat-value">${sol(volume)} <small>SOL</small></div><div class="stat-note">${state.mode === 'sandbox' ? 'Simulated' : 'Finalized'} · latest 200 payments</div></div>
      <div class="stat"><div class="stat-label">Awaiting approval <span class="stat-icon">◎</span></div><div class="stat-value">${pending.length}</div><div class="stat-note">${pending.length ? 'Budget reserved until a decision' : 'Your review queue is clear'}</div></div>
      <div class="stat"><div class="stat-label">Wallet policies <span class="stat-icon">⊙</span></div><div class="stat-value">${state.wallets.length}</div><div class="stat-note"><em>Server-enforced</em> · checked before signing</div></div>
    </div>
    <div class="grid-two"><section class="panel"><div class="panel-header"><h2>Your wallets</h2><button class="text-button" data-view="wallets">View all ↗</button></div>${state.wallets.length ? state.wallets.slice(0, 3).map(w => `<div class="wallet-mini"><div class="wallet-icon">▣</div><div><div class="wallet-name">${escape(w.name)}</div><div class="mono">${short(w.address)}</div></div><div class="wallet-right">${state.mode === 'sandbox' ? `${sol(w.balance)} SOL` : 'Devnet'}<small>${w.policy.paused ? 'Payments paused' : 'Policy active'}</small></div></div>`).join('') : empty('A home for your first wallet', 'Create a Solana wallet in seconds.', '<button class="secondary" data-action="new-wallet">Create your first wallet</button>')}</section>
    <section class="panel"><div class="panel-header"><h2>A simple path to your first payment</h2></div><div class="panel-body steps"><div class="step"><span class="step-number">1</span><div><strong>Create a wallet</strong><p>${state.mode === 'sandbox' ? 'Start with 10 simulated SOL, ready to explore.' : 'Fund your address using the Solana devnet faucet.'}</p></div></div><div class="step"><span class="step-number">2</span><div><strong>Set the boundaries</strong><p>Choose spending limits and trusted recipients.</p></div></div><div class="step"><span class="step-number">3</span><div><strong>Make your first payment</strong><p>Follow every decision in the activity log.</p></div></div></div></section></div>
    <section class="panel"><div class="panel-header"><div><h2>Recent payments</h2><p>A clear trail of every payment decision.</p></div><button class="text-button" data-view="payments">View all ↗</button></div>${paymentTable(state.payments.slice(0, 5))}</section>`;
}
function wallets() {
  return heading('Your wallets', 'Solana accounts with clear permissions and a dedicated spending budget.', createButton) +
    `<div class="notice">${state.mode === 'sandbox' ? 'Sandbox wallets start with 10 simulated SOL. These balances and payments exist only in this local workspace.' : 'Devnet wallets start unfunded. Fund the address with devnet SOL, then refresh its balance. Payments include network fees.'}</div>` +
    (state.wallets.length ? `<div class="card-grid">${state.wallets.map(w => `<section class="panel wallet-card"><div class="card-title"><div class="wallet-icon">▣</div>${badge(w.policy.paused ? 'paused' : 'active')}</div><div><div class="wallet-name">${escape(w.name)}</div><div class="mono address-line">${w.address}</div></div><div class="card-balance">${state.mode === 'sandbox' ? sol(w.balance) : balances.has(w.id) ? sol(balances.get(w.id)) : '—'} <small>SOL</small></div><div class="card-meta"><span>Committed / daily budget</span><span>${sol(w.committed)} / ${sol(w.policy.daily)}</span></div><div class="card-footer"><button class="secondary" data-action="new-payment" data-id="${w.id}">Send ↗</button><button class="secondary" data-action="policy" data-id="${w.id}">Policy</button><button class="text-button" data-action="copy" data-id="${w.address}">Copy</button>${state.mode === 'devnet' ? `<button class="text-button" data-action="balance" data-id="${w.id}">Refresh</button>` : ''}</div></section>`).join('')}</div>` : `<div class="panel">${empty('No wallets yet', 'Create your first wallet to start building.', createButton)}</div>`);
}
function approvals() {
  const payments = state.payments.filter(p => p.status === 'pending');
  return heading('Approval inbox', 'Review payments that need a human decision. Pending requests reserve budget.') +
    (payments.length ? payments.map(p => `<section class="panel review-card"><div class="wallet-icon">◎</div><div class="review-info"><h3>${walletName(p.wallet_id)}</h3><p class="mono long-address">To ${p.recipient}</p><p>${escape(p.memo || 'No note provided')} · ${date(p.created_at)}</p></div><div class="amount">${sol(p.amount)} <small>SOL</small></div><div class="actions"><button class="secondary danger" data-action="reject" data-id="${p.id}">Reject</button><button class="primary" data-action="approve" data-id="${p.id}">Approve ↗</button></div></section>`).join('') : `<section class="panel">${empty('All caught up', 'Payments above the wallet’s approval threshold will appear here.')}</section>`);
}
function policies() {
  return heading('Wallet policies', 'Define what each wallet can spend, where it can send, and when you step in.') + `<div class="notice">Budgets reset at midnight UTC. Pending and unconfirmed payments stay reserved across day boundaries. Human approval never overrides a hard limit or a paused wallet.</div>` +
    (state.wallets.length ? `<div class="card-grid">${state.wallets.map(w => `<section class="panel policy-card"><div class="card-title"><h3>${escape(w.name)}</h3>${badge(w.policy.paused ? 'paused' : 'active')}</div><div class="policy-values"><div><small>Daily budget</small><strong>${sol(w.policy.daily)} SOL</strong></div><div><small>Per-payment limit</small><strong>${sol(w.policy.perTransfer)} SOL</strong></div><div><small>Approval above</small><strong>${sol(w.policy.approvalAbove)} SOL</strong></div><div><small>Recipients</small><strong>${w.policy.allowlist.length ? `${w.policy.allowlist.length} allowed` : 'Any address'}</strong></div></div><button class="secondary" data-action="policy" data-id="${w.id}">Edit policy ↗</button></section>`).join('')}</div>` : `<div class="panel">${empty('Create a wallet first', 'Every wallet starts with a default policy you can customize.', createButton)}</div>`);
}
function activity() {
  return heading('Activity log', 'The latest 100 wallet events, policy changes, and payment decisions.') + `<section class="panel">${state.audit.length ? state.audit.map(a => `<div class="audit-row"><div class="audit-dot"></div><div><strong>${escape(a.action)}</strong><p>${escape(a.detail)}</p><span class="mono">${escape(a.resource_id)}</span></div><time>${date(a.created_at)}</time></div>`).join('') : empty('A clear trail starts here', 'Create a wallet to record the first event.')}</section>`;
}
function developers() {
  return heading('Build with Orbit', 'A small, inspectable API for Solana wallet operations.') + `<div class="docs"><div class="notice">Development preview: one trusted local operator. No end-user login, tenant isolation, managed custody, or mainnet support yet. Local encryption is not a secure enclave.</div><h2>01 · Create a wallet</h2><p>The API uses a local bearer credential stored at <code>.data/${state.mode}/api-token</code>. Read it into your application’s environment; keep it on the server.</p><pre class="code">import { OrbitClient } from './src/client.js';

const orbit = new OrbitClient({
  baseUrl: 'http://localhost:4310',
  token: process.env.ORBIT_API_TOKEN
});

const wallet = await orbit.createWallet('Payout agent');</pre><h2>02 · Request a payment</h2><p>Amounts are decimal SOL strings. Reuse the same idempotency key when retrying a request; a changed payload with the same key is rejected.</p><pre class="code">const payment = await orbit.requestPayment({
  walletId: wallet.id,
  recipient: 'RECIPIENT_SOLANA_ADDRESS',
  amount: '0.05',
  memo: 'Contributor payout'
}, 'payout-unique-reference');</pre><h2>03 · Follow the decision</h2><p>Sandbox: <code>simulated</code> means the local ledger was updated. Devnet: <code>submitted</code> means a signed transaction was persisted and broadcast attempted. Use the status check until it is finalized. A timeout keeps the budget reserved.</p><pre class="code">GET   /api/state
POST  /api/wallets
GET   /api/wallets/:id/balance
PATCH /api/wallets/:id/policy
POST  /api/payments
POST  /api/payments/:id/decision
POST  /api/payments/:id/execute
POST  /api/payments/:id/reconcile</pre><h2>Switch to Solana devnet</h2><p>Stop the server, then run <code>NETWORK=devnet npm start</code>. Devnet uses a separate database and key. Create and fund a wallet using the <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">Solana faucet ↗</a>. This version supports native SOL transfers. SPL tokens and USDC are next.</p></div>`;
}
function render() {
  $('#breadcrumb').textContent = titles[view];
  $('#network').textContent = state.mode === 'sandbox' ? '● Sandbox' : '● Solana devnet';
  $('#approval-count').textContent = state.payments.filter(p => p.status === 'pending').length;
  document.querySelectorAll('nav [data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const pages = { overview, wallets, approvals, policies, activity, developers, payments: () => heading('Payments', 'The latest 200 requests, plus every payment still awaiting action.', payButton) + `<section class="panel">${paymentTable(state.payments)}</section>` };
  $('#main').innerHTML = pages[view]();
}
function openDialog(title, description, content) {
  $('#dialog-content').innerHTML = `<div class="dialog-header"><div><h2>${title}</h2><p>${description}</p></div><button class="close" data-action="close" aria-label="Close dialog">×</button></div>${content}`;
  $('#dialog').showModal();
}
const formFooter = label => `<div class="form-error" role="alert"></div><div class="form-footer"><button type="button" class="secondary" data-action="close">Cancel</button><button class="primary" type="submit">${label}</button></div>`;
function newWallet() {
  openDialog('Create a Solana wallet', 'Give this wallet a name that explains its purpose.', `<form id="wallet-form"><label>Wallet name<input name="name" placeholder="e.g. Contributor payouts" maxlength="60" required autofocus></label><div class="notice">${state.mode === 'sandbox' ? 'Includes 10 simulated SOL for local testing.' : 'Starts unfunded. Fund with devnet SOL after creation.'} Keys are encrypted locally.</div>${formFooter('Create wallet ↗')}</form>`);
}
function newPayment(id) {
  if (!state.wallets.length) { notify('Create a wallet before requesting a payment.'); newWallet(); return; }
  openDialog('Request a payment', state.mode === 'sandbox' ? 'Test your payment policy with simulated SOL.' : 'Send SOL on Solana devnet. Network fees apply.', `<form id="payment-form" data-key="${crypto.randomUUID()}"><label>From wallet<select name="walletId">${state.wallets.map(w => `<option value="${w.id}" ${w.id === id ? 'selected' : ''}>${escape(w.name)}</option>`).join('')}</select></label><label>Recipient address<input name="recipient" placeholder="Solana public address" required minlength="32" maxlength="44" spellcheck="false" autocomplete="off"></label><label>Amount in SOL<input name="amount" inputmode="decimal" placeholder="0.05" required pattern="[0-9]+(\.[0-9]{1,9})?"><span class="field-hint">Up to 9 decimal places. Your wallet policy decides whether approval is needed.</span></label><label>Internal note <span class="field-hint">Optional · not written on-chain</span><input name="memo" maxlength="180" placeholder="What is this payment for?"></label>${formFooter('Request payment ↗')}</form>`);
}
function editPolicy(id) {
  const w = state.wallets.find(w => w.id === id); const p = w.policy;
  openDialog('Edit wallet policy', escape(w.name), `<form id="policy-form" data-id="${id}"><div class="form-row"><label>Daily budget · SOL<input name="daily" inputmode="decimal" value="${decimal(p.daily)}" required></label><label>Per-payment limit · SOL<input name="perTransfer" inputmode="decimal" value="${decimal(p.perTransfer)}" required></label></div><label>Require approval above · SOL<input name="approvalAbove" inputmode="decimal" value="${decimal(p.approvalAbove)}" required><span class="field-hint">Set to 0 to require approval for every payment.</span></label><label>Allowed recipients<textarea name="allowlist" placeholder="One Solana address per line">${p.allowlist.join('\n')}</textarea><span class="field-hint">Leave empty to permit any valid address.</span></label><label class="checkbox"><input type="checkbox" name="paused" ${p.paused ? 'checked' : ''}> Pause all outgoing payments</label>${formFooter('Save policy')}</form>`);
}
function paymentDetail(id) {
  const p = state.payments.find(p => p.id === id);
  openDialog('Payment details', `${sol(p.amount)} SOL · ${p.status}`, `<div class="panel-body"><div class="notice">${escape(p.reason)}</div><p>From ${walletName(p.wallet_id)}</p><p class="mono long-address">To ${p.recipient}</p><p>${escape(p.memo)}</p><p class="mono">${date(p.created_at)}</p>${p.signature ? `<p class="long-address"><a href="https://explorer.solana.com/tx/${encodeURIComponent(p.signature)}?cluster=devnet" target="_blank" rel="noreferrer">View on Solana Explorer ↗</a></p>` : ''}<div class="form-footer">${p.status === 'submitted' ? `<button class="primary" data-action="reconcile" data-id="${id}">Check confirmation</button>` : p.status === 'ready' ? `<button class="primary" data-action="execute" data-id="${id}">Retry preparation</button>` : '<button class="secondary" data-action="close">Close</button>'}</div></div>`);
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.view) { view = button.dataset.view; render(); return; }
  const { action, id } = button.dataset;
  if (action === 'close') { $('#dialog').close(); return; }
  if (action === 'new-wallet') return newWallet();
  if (action === 'new-payment') return newPayment(id);
  if (action === 'policy') return editPolicy(id);
  if (action === 'payment-detail') return paymentDetail(id);
  button.disabled = true;
  try {
    if (action === 'copy') { await navigator.clipboard.writeText(id); notify('Wallet address copied.'); }
    if (action === 'balance') { const result = await api(`/wallets/${id}/balance`); balances.set(id, result.lamports); render(); }
    if (['approve', 'reject'].includes(action)) {
      const result = await api(`/payments/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision: action }) });
      await refresh(); notify(result.reason);
    }
    if (['reconcile', 'execute'].includes(action)) {
      const result = await api(`/payments/${id}/${action}`, { method: 'POST', body: '{}' });
      $('#dialog').close(); await refresh(); notify(result.reason);
    }
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
});
document.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target; const submit = form.querySelector('[type="submit"]');
  submit.disabled = true; form.querySelector('.form-error').textContent = '';
  try {
    const data = Object.fromEntries(new FormData(form));
    let message;
    if (form.id === 'wallet-form') { await api('/wallets', { method: 'POST', body: JSON.stringify(data) }); message = 'Wallet created. Your policy is ready to configure.'; }
    if (form.id === 'payment-form') { const p = await api('/payments', { method: 'POST', headers: { 'Idempotency-Key': form.dataset.key }, body: JSON.stringify(data) }); message = p.reason; }
    if (form.id === 'policy-form') {
      await api(`/wallets/${form.dataset.id}/policy`, { method: 'PATCH', body: JSON.stringify({ ...data, paused: data.paused === 'on', allowlist: data.allowlist.split(/\s+/).filter(Boolean) }) });
      message = 'Policy saved. Future execution checks use these rules.';
    }
    $('#dialog').close(); await refresh(); notify(message);
  } catch (error) { form.querySelector('.form-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
refresh().catch(error => { $('#main').innerHTML = `<div class="connection-error"><h2>Unable to load the workspace</h2><p>${escape(error.message)} Refresh this page to retry.</p></div>`; });
