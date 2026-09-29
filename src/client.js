export class OrbitClient {
  constructor({ baseUrl = 'http://localhost:4310', token }) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); this.token = token;
  }
  async request(path, method = 'GET', body, headers = {}) {
    const response = await fetch(`${this.baseUrl}/api${path}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  state() { return this.request('/state'); }
  createWallet(name) { return this.request('/wallets', 'POST', { name }); }
  updatePolicy(id, policy) { return this.request(`/wallets/${encodeURIComponent(id)}/policy`, 'PATCH', policy); }
  requestPayment(payment, idempotencyKey) { return this.request('/payments', 'POST', payment, { 'Idempotency-Key': idempotencyKey }); }
  decide(id, decision) { return this.request(`/payments/${encodeURIComponent(id)}/decision`, 'POST', { decision }); }
  reconcile(id) { return this.request(`/payments/${encodeURIComponent(id)}/reconcile`, 'POST', {}); }
}
