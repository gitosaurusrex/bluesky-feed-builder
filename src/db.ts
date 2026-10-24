import { randomUUID } from 'node:crypto'
import type { Client, InArgs, Row } from '@libsql/client'
import type { Candidate } from './feeds/post.js'

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS feeds (
    id TEXT PRIMARY KEY,
    definition TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS kv (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (namespace, key)
  )`,
  `CREATE TABLE IF NOT EXISTS locks (
    name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS remembered (
    feed_id TEXT NOT NULL,
    uri TEXT NOT NULL,
    sort_at INTEGER NOT NULL,
    candidate TEXT NOT NULL,
    PRIMARY KEY (feed_id, uri)
  )`,
]

export interface StoredFeed {
  id: string
  /** The feed definition as JSON, exactly as saved by the editor. */
  definition: unknown
  createdAt: number
  updatedAt: number
}

const toStoredFeed = (row: Row): StoredFeed => ({
  id: String(row.id),
  definition: JSON.parse(String(row.definition)),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

/** Opens Turso (libsql:// or https://) or a local SQLite file (file:local.db, :memory:). */
export async function openDatabase(url: string, authToken?: string): Promise<Database> {
  // The web client is pure fetch, which keeps native SQLite bindings out of serverless bundles.
  const remote = /^(libsql|https?|wss?):/.test(url)
  const { createClient } = remote ? await import('@libsql/client/web') : await import('@libsql/client')
  return new Database(createClient({ url, authToken }))
}

/** Everything this app persists: editor feeds, OAuth state and sessions, dashboard logins and locks. */
export class Database {
  private ready?: Promise<unknown>

  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  private migrate() {
    this.ready ??= this.client.batch(MIGRATIONS, 'write').catch((err) => {
      this.ready = undefined
      throw err
    })
    return this.ready
  }

  private async run(sql: string, args: InArgs = []) {
    await this.migrate()
    return this.client.execute({ sql, args })
  }

  async listFeeds(): Promise<StoredFeed[]> {
    const { rows } = await this.run('SELECT id, definition, created_at, updated_at FROM feeds ORDER BY created_at')
    return rows.map(toStoredFeed)
  }

  async getFeed(id: string): Promise<StoredFeed | undefined> {
    const { rows } = await this.run('SELECT id, definition, created_at, updated_at FROM feeds WHERE id = ?', [id])
    return rows[0] ? toStoredFeed(rows[0]) : undefined
  }

  /** Creates a feed, failing if the id is taken. */
  async createFeed(id: string, definition: unknown): Promise<void> {
    const now = this.now()
    const { rowsAffected } = await this.run(
      'INSERT INTO feeds (id, definition, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      [id, JSON.stringify(definition), now, now],
    )
    if (!rowsAffected) throw new Error(`A feed with id "${id}" already exists`)
  }

  async updateFeed(id: string, definition: unknown): Promise<void> {
    // Updated times must increase, because they also serve as the cache version.
    const { rowsAffected } = await this.run(
      'UPDATE feeds SET definition = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?',
      [JSON.stringify(definition), this.now(), id],
    )
    if (!rowsAffected) throw new Error(`No feed with id "${id}"`)
  }

  async deleteFeed(id: string): Promise<void> {
    await this.run('DELETE FROM feeds WHERE id = ?', [id])
    await this.forgetPosts(id)
  }

  /** Posts a feed with `remember` has kept, newest first, as they looked when last seen. */
  async rememberedPosts(feedId: string): Promise<Candidate[]> {
    const { rows } = await this.run('SELECT candidate FROM remembered WHERE feed_id = ? ORDER BY sort_at DESC', [feedId])
    return rows.map((row) => JSON.parse(String(row.candidate)) as Candidate)
  }

  /** Remembers posts for a feed, keeping the newest `limit`. Posts it already has are left as they are. */
  async rememberPosts(feedId: string, candidates: Candidate[], limit: number): Promise<void> {
    if (!candidates.length) return
    await this.migrate()
    await this.client.batch(
      [
        ...candidates.map((c) => ({
          sql: 'INSERT INTO remembered (feed_id, uri, sort_at, candidate) VALUES (?, ?, ?, ?) ON CONFLICT(feed_id, uri) DO NOTHING',
          args: [feedId, c.post.uri, c.sortAt, JSON.stringify(c)],
        })),
        {
          sql: `DELETE FROM remembered WHERE feed_id = ? AND uri NOT IN
                (SELECT uri FROM remembered WHERE feed_id = ? ORDER BY sort_at DESC LIMIT ?)`,
          args: [feedId, feedId, limit],
        },
      ],
      'write',
    )
  }

  async forgetPosts(feedId: string): Promise<void> {
    await this.run('DELETE FROM remembered WHERE feed_id = ?', [feedId])
  }

  /**
   * Returns the stored value, or stores and returns a new one from `create`.
   * If several instances race, they all end up with whichever value was stored first.
   */
  async getOrCreate<T>(namespace: string, key: string, create: () => Promise<T>): Promise<T> {
    const store = this.kv<T>(namespace)
    const existing = await store.get(key)
    if (existing !== undefined) return existing
    await this.run(
      'INSERT INTO kv (namespace, key, value, expires_at) VALUES (?, ?, ?, NULL) ON CONFLICT(namespace, key) DO NOTHING',
      [namespace, key, JSON.stringify(await create())],
    )
    return (await store.get(key))!
  }

  /** A namespaced key-value store with optional expiry, used for OAuth and login sessions. */
  kv<T>(namespace: string, ttlMs?: number) {
    return {
      get: async (key: string): Promise<T | undefined> => {
        const { rows } = await this.run('SELECT value, expires_at FROM kv WHERE namespace = ? AND key = ?', [namespace, key])
        const row = rows[0]
        if (!row) return undefined
        if (row.expires_at !== null && Number(row.expires_at) <= this.now()) {
          await this.run('DELETE FROM kv WHERE namespace = ? AND key = ?', [namespace, key])
          return undefined
        }
        return JSON.parse(String(row.value)) as T
      },
      set: async (key: string, value: T): Promise<void> => {
        const now = this.now()
        if (ttlMs !== undefined) await this.run('DELETE FROM kv WHERE namespace = ? AND expires_at <= ?', [namespace, now])
        await this.run(
          `INSERT INTO kv (namespace, key, value, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
          [namespace, key, JSON.stringify(value), ttlMs === undefined ? null : now + ttlMs],
        )
      },
      del: async (key: string): Promise<void> => {
        await this.run('DELETE FROM kv WHERE namespace = ? AND key = ?', [namespace, key])
      },
    }
  }

  /**
   * Runs `fn` while holding a lock shared by every instance of the app. OAuth
   * uses this so two serverless instances never refresh the same token at once.
   */
  async withLock<T>(name: string, fn: () => T | PromiseLike<T>, { ttlMs = 30_000, waitMs = 15_000 } = {}): Promise<T> {
    const owner = randomUUID()
    const deadline = this.now() + waitMs
    for (;;) {
      const now = this.now()
      const { rowsAffected } = await this.run(
        `INSERT INTO locks (name, owner, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE locks.expires_at < ?`,
        [name, owner, now + ttlMs, now],
      )
      if (rowsAffected) break
      if (now > deadline) throw new Error(`Timed out waiting for lock "${name}"`)
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100))
    }
    try {
      return await fn()
    } finally {
      await this.run('DELETE FROM locks WHERE name = ? AND owner = ?', [name, owner])
    }
  }
}
