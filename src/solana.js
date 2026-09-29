import { randomBytes } from 'node:crypto';
import {
  address, createKeyPairSignerFromPrivateKeyBytes, createSolanaRpc,
  createTransactionMessage, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstruction,
  signTransactionMessageWithSigners, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, pipe,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';

export function validateAddress(value) {
  if (typeof value !== 'string') throw new Error('Invalid Solana address.');
  return address(value);
}

// Provider boundary: replace this local signer with a managed signer before production.
export async function generateWallet() {
  const seed = randomBytes(32);
  try {
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    return { address: signer.address, seed };
  } catch (error) { seed.fill(0); throw error; }
}

export class DevnetProvider {
  constructor() { this.rpc = createSolanaRpc('https://api.devnet.solana.com'); }
  async balance(walletAddress) {
    const { value } = await this.rpc.getBalance(address(walletAddress)).send({ abortSignal: AbortSignal.timeout(15_000) });
    return value.toString();
  }
  async prepare(seed, recipient, amount) {
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const { value: lifetime } = await this.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send({ abortSignal: AbortSignal.timeout(15_000) });
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      tx => setTransactionMessageFeePayerSigner(signer, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
      tx => appendTransactionMessageInstruction(getTransferSolInstruction({ source: signer, destination: address(recipient), amount: BigInt(amount) }), tx),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const wire = getBase64EncodedWireTransaction(signed);
    const { value } = await this.rpc.simulateTransaction(wire, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }).send({ abortSignal: AbortSignal.timeout(15_000) });
    if (value.err) throw new Error('Devnet simulation failed. Check wallet funds, fees, and recipient.');
    return { wire, signature: getSignatureFromTransaction(signed), lastValidHeight: lifetime.lastValidBlockHeight.toString() };
  }
  async broadcast(wire) {
    return this.rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: false, maxRetries: 3n }).send({ abortSignal: AbortSignal.timeout(15_000) });
  }
  async status(signature) {
    const { value } = await this.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send({ abortSignal: AbortSignal.timeout(15_000) });
    return value[0];
  }
}
