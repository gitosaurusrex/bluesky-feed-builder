import type { Agent } from '@atproto/api'
import type { Bsky } from './bsky.js'
import type { Database } from './db.js'
import { parseFeed } from './feeds/define.js'
import type { CombinedRegistry } from './feeds/registry.js'
import { FEED_COLLECTION } from './publish.js'

/**
 * The field in a feed's Bluesky record that keeps a copy of its settings, the
 * way SkyFeed keeps `skyfeedBuilder`. If the database is ever lost or swapped,
 * the feed can be rebuilt from its own record.
 */
export const BACKUP_FIELD = 'blueFeeds'

export interface FeedBackup {
  version: 1
  /**
   * The settings as JSON text. Bluesky records can't hold decimal numbers, so
   * a setting like "max age 1.5 hours" can't be stored as a plain object.
   */
  definition: string
  savedAt: string
}

export function makeBackup(definition: unknown): FeedBackup {
  return { version: 1, definition: JSON.stringify(definition), savedAt: new Date().toISOString() }
}

/** The feed settings saved in a record, if it has a usable backup. */
export function backupOf(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const backup = record?.[BACKUP_FIELD] as { version?: unknown; definition?: unknown } | undefined
  if (backup?.version !== 1 || typeof backup.definition !== 'string') return undefined
  try {
    const definition: unknown = JSON.parse(backup.definition)
    return definition && typeof definition === 'object' && !Array.isArray(definition) ? (definition as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Refreshes the backup in a published feed's record after its settings change.
 * Leaves the rest of the record alone, and does nothing for feeds that aren't
 * published or are served by another service.
 */
export async function syncBackup(agent: Agent, id: string, definition: unknown, serviceDid: string): Promise<boolean> {
  let record: Record<string, unknown>
  try {
    const { data } = await agent.com.atproto.repo.getRecord({ repo: agent.assertDid, collection: FEED_COLLECTION, rkey: id })
    record = data.value as Record<string, unknown>
  } catch {
    return false // not published
  }
  if (record.did !== serviceDid) return false
  await agent.com.atproto.repo.putRecord({
    repo: agent.assertDid,
    collection: FEED_COLLECTION,
    rkey: id,
    record: { ...record, [BACKUP_FIELD]: makeBackup(definition) },
  })
  return true
}

/** How long to wait before looking again at a feed that couldn't be restored. */
const MISS_TTL_MS = 5 * 60_000

/** Puts feeds back in the database from the backups in their Bluesky records. */
export class FeedRestorer {
  private readonly misses = new Map<string, number>()
  private readonly pending = new Map<string, Promise<boolean>>()

  constructor(
    private readonly deps: { bsky: Pick<Bsky, 'getRecord'>; db: Database; registry: CombinedRegistry },
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Restores the owner's feed `id` if its record points at this service and
   * carries a backup. Called when Bluesky asks for a feed the database doesn't
   * have, so a lost database heals itself on the next request.
   */
  restore(ownerDid: string, id: string, serviceDid: string): Promise<boolean> {
    const key = `${ownerDid}/${id}`
    const missedAt = this.misses.get(key)
    if (missedAt !== undefined && this.now() - missedAt < MISS_TTL_MS) return Promise.resolve(false)
    let pending = this.pending.get(key)
    if (!pending) {
      pending = this.deps.bsky
        .getRecord(`at://${ownerDid}/${FEED_COLLECTION}/${id}`)
        .then((record) => this.restoreFrom(id, record, serviceDid))
        .catch((err) => {
          console.error(`Restoring feed "${id}" failed:`, err)
          return false
        })
        .then((restored) => {
          if (!restored) this.misses.set(key, this.now())
          return restored
        })
        .finally(() => this.pending.delete(key))
      this.pending.set(key, pending)
    }
    return pending
  }

  /** Restores a feed from a record already in hand. Returns whether the feed is now saved. */
  async restoreFrom(id: string, record: Record<string, unknown>, serviceDid: string): Promise<boolean> {
    const definition = backupOf(record)
    if (!definition || record.did !== serviceDid || this.deps.registry.isCodeFeed(id)) return false
    const restored = { ...definition, id }
    parseFeed(restored) // a backup that no longer validates is left for the owner to fix
    if (!(await this.deps.db.getFeed(id))) {
      await this.deps.db.createFeed(id, restored).catch(async (err) => {
        if (!(await this.deps.db.getFeed(id))) throw err // lost a race with another instance: fine
      })
      console.warn(`Restored feed "${id}" from the backup in its Bluesky record.`)
    }
    this.deps.registry.invalidate()
    return true
  }
}
