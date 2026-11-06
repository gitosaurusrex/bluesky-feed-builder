import { createHash } from 'node:crypto'
import { feeds } from '../feeds/index.js'
import { type ManageDeps, createApp } from './app.js'
import { Logins, type OwnerAuth, createOwnerAuth } from './auth.js'
import { FeedRestorer } from './backup.js'
import { Members } from './members.js'
import { Bsky } from './bsky.js'
import { loadConfig } from './config.js'
import { openDatabase } from './db.js'
import { REMEMBER_LIMIT, parseFeeds } from './feeds/define.js'
import { FeedEngine } from './feeds/engine.js'
import { CombinedRegistry, StaticRegistry } from './feeds/registry.js'
import { createSourceFetcher, hydratePosts } from './feeds/sources.js'

/**
 * Wires the app together from environment variables and the feeds in
 * `feeds/index.ts`. With TURSO_DATABASE_URL set, it also turns on sign-in and
 * the feed editor.
 */
export async function createInstance(options: { waitUntil?: (promise: Promise<unknown>) => void } = {}) {
  const config = loadConfig()
  const codeFeeds = parseFeeds(feeds)
  const db = config.database ? await openDatabase(config.database.url, config.database.authToken) : undefined

  let auth: Promise<OwnerAuth> | undefined
  const getAuth = () => {
    auth ??= createOwnerAuth(config, db!).catch((err) => {
      auth = undefined
      throw err
    })
    return auth
  }

  // Each member's searches and likes run with their own signed-in session.
  const bsky: Bsky = new Bsky(config, {
    sessionAgent: db ? async (did) => (await getAuth()).appviewAgent(did) : undefined,
  })
  const codeOwner = () => bsky.ownerDid()

  // Feeds saved before accounts existed belong to the admin; move them over once, before anything reads feeds.
  let adopted: Promise<void> | undefined
  const adoptLegacyFeeds = () => {
    adopted ??= (async () => {
      const admin = await bsky.ownerDid()
      if (!admin || !db) throw new Error('admin unknown')
      const moved = await db.adoptLegacyFeeds(admin)
      if (moved) console.warn(`Moved ${moved} saved feeds to the admin account ${admin}.`)
    })().catch((err) => {
      adopted = undefined
      if (err instanceof Error && err.message !== 'admin unknown') console.error('Moving saved feeds failed:', err)
    })
    return adopted
  }
  // Start the move straight away, so a request that reads one feed directly never finds it missing.
  if (db) void adoptLegacyFeeds()
  const store = db
    ? {
        listFeeds: async () => {
          await adoptLegacyFeeds()
          return db.listFeeds()
        },
      }
    : undefined

  const registry = store ? new CombinedRegistry(codeFeeds, store, undefined, undefined, codeOwner) : new StaticRegistry(codeFeeds, codeOwner)
  const manage: ManageDeps | undefined =
    db && registry instanceof CombinedRegistry
      ? {
          db,
          registry,
          logins: new Logins(db),
          auth: getAuth,
          restorer: new FeedRestorer({ bsky, db, registry }),
          members: new Members(bsky, config.allowedAccounts),
          databaseId: createHash('sha256').update(config.database!.url).digest('hex').slice(0, 10),
          databaseHost: databaseHost(config.database!.url),
        }
      : undefined

  const engine = new FeedEngine(registry, {
    fetchSource: createSourceFetcher(bsky),
    resolvePostUri: (input) => bsky.toAtUri(input, 'app.bsky.feed.post'),
    hydratePosts: (uris) => hydratePosts(bsky, uris),
    cacheSeconds: config.cacheSeconds,
    staleSeconds: config.staleSeconds,
    waitUntil: options.waitUntil,
    memory: db
      ? { load: (id) => db.rememberedPosts(id), add: (id, candidates) => db.rememberPosts(id, candidates, REMEMBER_LIMIT) }
      : undefined,
  })
  return { config, bsky, engine, app: createApp({ config, engine, bsky, manage }) }
}

/** The host of a libsql:// or https:// address, or the path of a local file, for showing where data lives. */
function databaseHost(url: string): string {
  if (!/^(libsql|https?|wss?):/.test(url)) return url
  try {
    return new URL(url).host
  } catch {
    return 'unreadable address'
  }
}
