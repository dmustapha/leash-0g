import { MemData, Indexer, defaultUploadOption } from '@0gfoundation/0g-storage-ts-sdk';
import { Wallet, JsonRpcProvider } from 'ethers';
import type { StorageUploader } from './batcher.js';

export interface ZeroGStorageOptions {
  indexerUrl: string;
  rpcUrl: string;
  opsPrivateKey: string;
}

/**
 * 0G Storage Log Layer wrapper (spike learnings, PHASE-0 §3.3):
 * MemData for in-memory blobs; Indexer.upload returns an [res, err] tuple;
 * the SDK bundles its own ethers copy, so the signer arg is cast at the call
 * site to avoid the dual-package type clash.
 */
export class ZeroGStorage implements StorageUploader {
  private readonly indexer: Indexer;
  private readonly signer: Wallet;

  constructor(private readonly opts: ZeroGStorageOptions) {
    this.indexer = new Indexer(opts.indexerUrl);
    this.signer = new Wallet(opts.opsPrivateKey, new JsonRpcProvider(opts.rpcUrl));
  }

  async upload(data: Buffer): Promise<{ root: string; txHash: string }> {
    const file = new MemData(data);
    const [res, err] = await this.indexer.upload(
      file,
      this.opts.rpcUrl,
      // SDK resolves ethers through its CJS entry while we use ESM — same
      // runtime package, incompatible nominal types. Cast per spike finding.
      this.signer as unknown as Parameters<Indexer['upload']>[2],
      { ...defaultUploadOption },
    );
    if (err !== null || res === null) {
      throw new Error(`0G storage upload failed: ${err?.message ?? 'no result'}`);
    }
    if ('txHash' in res) return { root: res.rootHash, txHash: res.txHash };
    const root = res.rootHashes[0];
    const txHash = res.txHashes[0];
    if (!root || !txHash) throw new Error('0G storage upload returned empty batch result');
    return { root, txHash };
  }

  /** Download a blob by its Merkle root (owner-side + live tests). */
  async download(rootHash: string): Promise<Buffer> {
    const [blob, err] = await this.indexer.downloadToBlob(rootHash);
    if (err !== null || !blob) throw new Error(`0G storage download failed: ${err?.message ?? 'no blob'}`);
    return Buffer.from(await blob.arrayBuffer());
  }
}
