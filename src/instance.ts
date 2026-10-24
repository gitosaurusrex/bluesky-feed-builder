import { feeds } from '../feeds/index.js'
import { createApp } from './app.js'
import { Bsky } from './bsky.js'
import { loadConfig } from './config.js'
import { parseFeeds } from './feeds/define.js'
import { FeedEngine } from './feeds/engine.js'
import { createSourceFetcher, hydratePosts } from './feeds/sources.js'

/** Wires the app together from environment variables and the feeds in `feeds/index.ts`. */
export function createInstance(options: { waitUntil?: (promise: Promise<unknown>) => void } = {}) {
  const config = loadConfig()
  const bsky = new Bsky(config)
  const engine = new FeedEngine(parseFeeds(feeds), {
    fetchSource: createSourceFetcher(bsky),
    resolvePostUri: (input) => bsky.toAtUri(input, 'app.bsky.feed.post'),
    hydratePosts: (uris) => hydratePosts(bsky, uris),
    cacheSeconds: config.cacheSeconds,
    staleSeconds: config.staleSeconds,
    waitUntil: options.waitUntil,
  })
  return { config, bsky, engine, app: createApp({ config, engine, bsky }) }
}
