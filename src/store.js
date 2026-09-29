import { DatabaseSync } from 'node:sqlite';

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT UNIQUE NOT NULL,
      encrypted_key TEXT NOT NULL, balance INTEGER NOT NULL, policy TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES wallets(id),
      recipient TEXT NOT NULL, amount INTEGER NOT NULL, memo TEXT NOT NULL,
      status TEXT NOT NULL, reason TEXT NOT NULL, idempotency_key TEXT UNIQUE NOT NULL,
      fingerprint TEXT NOT NULL, human_approved INTEGER NOT NULL DEFAULT 0,
      signature TEXT, wire TEXT, last_valid_height TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,
      resource_id TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payments_wallet_status ON payments(wallet_id, status);
  `);
  return db;
}

export function atomic(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = operation(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
