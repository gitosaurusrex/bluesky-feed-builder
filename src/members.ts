import type { Bsky } from './bsky.js'

/**
 * Who may sign in and publish feeds through this service: the admin in
 * BSKY_IDENTIFIER, plus the accounts invited in ALLOWED_ACCOUNTS. Each member
 * has their own feeds and publishes them from their own account.
 */
export class Members {
  private cached?: { at: number; dids: Promise<Set<string>> }

  constructor(
    private readonly bsky: Pick<Bsky, 'ownerDid' | 'resolveDid'>,
    /** Handles or DIDs, as written in ALLOWED_ACCOUNTS. */
    private readonly invited: string[],
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Members' DIDs. A handle that doesn't resolve is skipped, and retried after a few minutes. */
  dids(): Promise<Set<string>> {
    const now = this.now()
    if (!this.cached || now - this.cached.at >= this.ttlMs) {
      this.cached = { at: now, dids: this.load() }
    }
    return this.cached.dids
  }

  async has(did: string | undefined): Promise<boolean> {
    return Boolean(did) && (await this.dids()).has(did!)
  }

  private async load(): Promise<Set<string>> {
    const resolved = await Promise.all([
      this.bsky.ownerDid(),
      ...this.invited.map((account) =>
        this.bsky.resolveDid(account).catch((err) => {
          console.error(`Couldn't find the invited account "${account}":`, err instanceof Error ? err.message : err)
          return undefined
        }),
      ),
    ])
    return new Set(resolved.filter((did): did is string => Boolean(did)))
  }
}
