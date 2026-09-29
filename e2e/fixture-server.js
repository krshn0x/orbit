import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { LocalVault } from '../src/vault.js';
import { WalletService } from '../src/service.js';
import { createApp } from '../src/server.js';
const directory = mkdtempSync(join(tmpdir(), 'orbit-browser-'));
const db = openStore(':memory:');
const service = new WalletService(db, new LocalVault(join(directory, 'key')));
const server = createApp({ service, token: 'browser-test-only', port: 4311 });
server.listen(4311, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => {
  db.close(); rmSync(directory, { recursive: true, force: true }); process.exit(0);
}));
