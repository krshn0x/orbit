import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore } from './store.js';
import { LocalVault } from './vault.js';
import { WalletService } from './service.js';
import { DevnetProvider } from './solana.js';
import { AppError } from './policy.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createApp({ service, token, port = 4310 }) {
  const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const actualPort = res.socket.localPort || port;
      const hosts = [`localhost:${actualPort}`, `127.0.0.1:${actualPort}`];
      if (!hosts.includes(req.headers.host)) throw new AppError('Invalid host.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && assets[url.pathname]) {
        // Loopback-only development login, not a production authentication system.
        if (url.pathname === '/') res.setHeader('Set-Cookie', `orbit_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
        const [file, type] = assets[url.pathname];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        res.end(readFileSync(join(root, 'public', file))); return;
      }
      const bearer = req.headers.authorization?.startsWith('Bearer ') && equal(req.headers.authorization.slice(7), token);
      const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('orbit_session='))?.slice(14);
      if (!bearer && !equal(cookie, token)) throw new AppError('Authentication required.', 401);
      if (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`)) throw new AppError('Cross-origin requests are not permitted.', 403);
      if (req.method !== 'GET' && !bearer && req.headers.origin !== `http://${req.headers.host}`) throw new AppError('Same-origin request required.', 403);
      let body = {};
      if (['POST', 'PATCH'].includes(req.method)) {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Content-Type must be application/json.', 415);
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 32_768) throw new AppError('Request body is too large.', 413);
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
        catch { throw new AppError('Invalid JSON body.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('Expected a JSON object.');
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200, service.snapshot());
      if (req.method === 'POST' && url.pathname === '/api/wallets') return send(201, await service.createWallet(body));
      if (req.method === 'PATCH' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'wallets' && parts[3] === 'policy') return send(200, service.updatePolicy(parts[2], body));
      if (req.method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'wallets' && parts[3] === 'balance') {
        const wallet = service.publicWallet(parts[2]);
        try { return send(200, { lamports: service.mode === 'sandbox' ? String(wallet.balance) : await service.provider.balance(wallet.address) }); }
        catch { throw new AppError('Unable to fetch devnet balance. Try again later.', 502); }
      }
      if (req.method === 'POST' && url.pathname === '/api/payments') return send(201, await service.requestPayment(body, req.headers['idempotency-key']));
      if (req.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'payments') {
        if (parts[3] === 'decision') return send(200, await service.decide(parts[2], body.decision));
        if (parts[3] === 'execute') return send(200, await service.execute(parts[2]));
        if (parts[3] === 'reconcile') return send(200, await service.reconcile(parts[2]));
      }
      throw new AppError('Endpoint not found.', 404);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (!error.status) console.error('Request failed:', error.name);
      send(error.status || 500, { error: error.status ? error.message : 'An internal error occurred.' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.env.NETWORK || 'sandbox';
  if (!['sandbox', 'devnet'].includes(mode)) throw new Error('NETWORK must be sandbox or devnet. Mainnet is not supported.');
  const directory = resolve(root, '.data', mode);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const dbPath = join(directory, 'platform.sqlite');
  const db = openStore(dbPath); chmodSync(dbPath, 0o600);
  const vault = new LocalVault(join(directory, 'master.key'), db.prepare('SELECT COUNT(*) AS n FROM wallets').get().n > 0);
  const tokenPath = join(directory, 'api-token');
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  const token = readFileSync(tokenPath, 'utf8').trim();
  const service = new WalletService(db, vault, { mode, provider: mode === 'devnet' ? new DevnetProvider() : null });
  const port = Number(process.env.PORT || 4310);
  const app = createApp({ service, token, port });
  app.listen(port, '127.0.0.1', () => console.log(`Orbit · ${mode} · http://localhost:${port}\nLocal operator access only. API credential: ${tokenPath}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close(() => { db.close(); process.exit(0); }));
}
