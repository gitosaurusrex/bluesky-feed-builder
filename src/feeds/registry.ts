import type { StoredFeed } from '../db.js'
import { type FeedDefinition, parseFeed } from './define.js'

export interface RegisteredFeed {
  def: FeedDefinition
  /** `code` feeds live in feeds/ and are read-only in the dashboard; `editor` feeds live in the database. */
  origin: 'code' | 'editor'
  /** Changes whenever the definition does, so cached results can be thrown away. */
  version: string
}

export interface RegistrySnapshot {
  feeds: RegisteredFeed[]
  /** Saved feeds that no longer validate, e.g. after an upgrade changed the schema. */
  broken: { id: string; error: string }[]
}

export interface FeedRegistry {
  list(): Promise<RegisteredFeed[]>
  get(id: string): Promise<RegisteredFeed | undefined>
}

/** Feeds defined in code only. */
export class StaticRegistry implements FeedRegistry {
  private readonly feeds: RegisteredFeed[]

  constructor(defs: FeedDefinition[]) {
    this.feeds = defs.map((def) => ({ def, origin: 'code', version: 'code' }))
  }

  async list() {
    return this.feeds
  }

  async get(id: string) {
    return this.feeds.find((f) => f.def.id === id)
  }
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
  private readonly codeIds: Set<string>

  constructor(
    codeFeeds: FeedDefinition[],
    private readonly store: { listFeeds(): Promise<StoredFeed[]> },
    private readonly ttlMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {
    this.code = new StaticRegistry(codeFeeds)
    this.codeIds = new Set(codeFeeds.map((f) => f.id))
  }

  isCodeFeed(id: string): boolean {
    return this.codeIds.has(id)
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

  async get(id: string) {
    return (await this.list()).find((f) => f.def.id === id)
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
      if (this.codeIds.has(row.id)) continue // feeds/ wins over a saved feed with the same id
      try {
        feeds.push({ def: parseFeed(row.definition), origin: 'editor', version: String(row.updatedAt) })
      } catch (err) {
        broken.push({ id: row.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    this.lastGood = { feeds, broken }
    return this.lastGood
  }
}
