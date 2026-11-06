import type { StoredFeed } from '../db.js'
import { type FeedDefinition, parseFeed } from './define.js'

export interface RegisteredFeed {
  def: FeedDefinition
  /** DID of the account the feed belongs to and is published from. Empty when that isn't known yet. */
  owner: string
  /** `code` feeds live in feeds/ and are read-only in the dashboard; `editor` feeds live in the database. */
  origin: 'code' | 'editor'
  /** Changes whenever the definition does, so cached results can be thrown away. */
  version: string
}

export interface RegistrySnapshot {
  feeds: RegisteredFeed[]
  /** Saved feeds that no longer validate, e.g. after an upgrade changed the schema. */
  broken: { owner: string; id: string; error: string }[]
}

export interface FeedRegistry {
  list(): Promise<RegisteredFeed[]>
  get(owner: string, id: string): Promise<RegisteredFeed | undefined>
}

/** Who owns the feeds in feeds/: the account in BSKY_IDENTIFIER, resolved when first needed. */
export type CodeOwner = () => Promise<string | undefined>

/** Feeds defined in code, which belong to the app's admin account. */
export class StaticRegistry implements FeedRegistry {
  constructor(
    private readonly defs: FeedDefinition[],
    private readonly codeOwner: CodeOwner = async () => undefined,
  ) {}

  async list(): Promise<RegisteredFeed[]> {
    const owner = (await this.codeOwner()) ?? ''
    return this.defs.map((def) => ({ def, owner, origin: 'code', version: 'code' }))
  }

  async get(owner: string, id: string) {
    return findFeed(await this.list(), owner, id)
  }

  async isCodeFeed(owner: string, id: string): Promise<boolean> {
    return Boolean(findFeed(await this.list(), owner, id))
  }
}

/** A feed by account and id. Code feeds whose owner isn't known yet match any account. */
function findFeed(feeds: RegisteredFeed[], owner: string, id: string): RegisteredFeed | undefined {
  return feeds.find((f) => f.def.id === id && (f.owner === owner || (f.origin === 'code' && f.owner === '')))
}

/**
 * Feeds from code plus feeds saved in the editor. Saved feeds are re-read at
 * most every `ttlMs`, so an edit made on one serverless instance reaches the
 * others within seconds.
 */
export class CombinedRegistry implements FeedRegistry {
  private cached?: { at: number; snapshot: Promise<RegistrySnapshot> }
  private lastGood?: RegistrySnapshot
  private readonly code: StaticRegistry

  constructor(
    codeFeeds: FeedDefinition[],
    private readonly store: { listFeeds(): Promise<StoredFeed[]> },
    private readonly ttlMs = 10_000,
    private readonly now: () => number = Date.now,
    codeOwner: CodeOwner = async () => undefined,
  ) {
    this.code = new StaticRegistry(codeFeeds, codeOwner)
  }

  /** Feeds in feeds/ belong to the admin and can't be replaced by a saved feed with the same id. */
  isCodeFeed(owner: string, id: string): Promise<boolean> {
    return this.code.isCodeFeed(owner, id)
  }

  invalidate(): void {
    this.cached = undefined
  }

  snapshot(): Promise<RegistrySnapshot> {
    const now = this.now()
    if (!this.cached || now - this.cached.at >= this.ttlMs) {
      this.cached = { at: now, snapshot: this.load() }
    }
    return this.cached.snapshot
  }

  async list() {
    return (await this.snapshot()).feeds
  }

  async get(owner: string, id: string) {
    return findFeed(await this.list(), owner, id)
  }

  private async load(): Promise<RegistrySnapshot> {
    const codeFeeds = await this.code.list()
    let stored: StoredFeed[]
    try {
      stored = await this.store.listFeeds()
    } catch (err) {
      // If the database is unreachable, keep serving what we had rather than failing every feed.
      console.error('Loading saved feeds failed:', err)
      this.cached = undefined
      return this.lastGood ?? { feeds: codeFeeds, broken: [] }
    }

    const feeds = [...codeFeeds]
    const broken: RegistrySnapshot['broken'] = []
    for (const row of stored) {
      if (findFeed(codeFeeds, row.owner, row.id)) continue // feeds/ wins over a saved feed with the same id
      try {
        feeds.push({ def: parseFeed(row.definition), owner: row.owner, origin: 'editor', version: String(row.updatedAt) })
      } catch (err) {
        broken.push({ owner: row.owner, id: row.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    this.lastGood = { feeds, broken }
    return this.lastGood
  }
}
