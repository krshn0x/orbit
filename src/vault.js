import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

export class LocalVault {
  constructor(path, hasWallets = false) {
    if (!existsSync(path)) {
      if (hasWallets) throw new Error('Master key missing. Restore it from backup; existing wallets cannot be decrypted.');
      writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    chmodSync(path, 0o600);
    this.key = readFileSync(path);
    if (this.key.length !== 32) throw new Error('Invalid vault master key.');
  }
  encrypt(bytes, walletId) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(walletId));
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  decrypt(envelope, walletId) {
    const bytes = Buffer.from(envelope, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(walletId));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  }
}
