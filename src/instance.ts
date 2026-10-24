import { feeds } from '../feeds/index.js'
import { type ManageDeps, createApp } from './app.js'
import { Logins, type OwnerAuth, createOwnerAuth } from './auth.js'
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

  const bsky: Bsky = new Bsky(config, {
    ownerAgent: db
      ? async () => {
          const did = await bsky.ownerDid()
          return did ? (await getAuth()).appviewAgent(did) : undefined
        }
      : undefined,
  })

  const registry = db ? new CombinedRegistry(codeFeeds, db) : new StaticRegistry(codeFeeds)
  const manage: ManageDeps | undefined =
    db && registry instanceof CombinedRegistry ? { db, registry, logins: new Logins(db), auth: getAuth } : undefined

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
