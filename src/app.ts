import { createHash, timingSafeEqual } from 'node:crypto'
import { AtUri } from '@atproto/api'
import { Hono } from 'hono'
import { html } from 'hono/html'
import type { Bsky } from './bsky.js'
import type { Config } from './config.js'
import { FeedValidationError, parseFeed } from './feeds/define.js'
import { FeedEngine, FeedError } from './feeds/engine.js'
import { dashboardPage, errorPage, playgroundPage, previewFragment, previewPage } from './web/views.js'

export interface AppDeps {
  config: Config
  engine: FeedEngine
  bsky: Bsky
}

const FEED_COLLECTION = 'app.bsky.feed.generator'

function sameSecret(a: string, b: string): boolean {
  const hash = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(hash(a), hash(b))
}

export function createApp({ config, engine, bsky }: AppDeps): Hono {
  const app = new Hono()

  const hostnameOf = (req: Request) =>
    config.hostname ?? req.headers.get('x-forwarded-host') ?? new URL(req.url).host
  const serviceDidOf = (req: Request) => config.serviceDid ?? `did:web:${hostnameOf(req)}`

  let publisher: Promise<string | undefined> | undefined
  const publisherDid = (): Promise<string | undefined> => {
    if (config.publisherDid) return Promise.resolve(config.publisherDid)
    const identifier = config.bsky.identifier
    if (!identifier || identifier.includes('@')) return Promise.resolve(undefined)
    publisher ??= bsky.resolveDid(identifier).catch((err) => {
      console.error(`Couldn't resolve BSKY_IDENTIFIER "${identifier}" to a DID:`, err)
      publisher = undefined
      return undefined
    })
    return publisher
  }

  const xrpcError = (status: 400 | 401 | 500 | 502, error: string, message: string) =>
    new Response(JSON.stringify({ error, message }), { status, headers: { 'content-type': 'application/json' } })

  app.get('/health', (c) => c.json({ ok: true, feeds: engine.feeds.length }))

  // The DID document that lets Bluesky find this service when it's identified by did:web.
  app.get('/.well-known/did.json', (c) => {
    const hostname = hostnameOf(c.req.raw)
    const did = serviceDidOf(c.req.raw)
    if (!did.startsWith('did:web:')) return c.notFound()
    return c.json({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did,
      service: [{ id: '#bsky_fg', type: 'BskyFeedGenerator', serviceEndpoint: `https://${hostname}` }],
    })
  })

  app.get('/xrpc/app.bsky.feed.describeFeedGenerator', async (c) => {
    const did = await publisherDid()
    return c.json({
      did: serviceDidOf(c.req.raw),
      feeds: did ? engine.feeds.map((f) => ({ uri: `at://${did}/${FEED_COLLECTION}/${f.id}` })) : [],
    })
  })

  app.get('/xrpc/app.bsky.feed.getFeedSkeleton', async (c) => {
    const feedParam = c.req.query('feed')
    if (!feedParam) return xrpcError(400, 'InvalidRequest', 'Missing required parameter: feed')
    let uri: AtUri
    try {
      uri = new AtUri(feedParam)
    } catch {
      return xrpcError(400, 'InvalidRequest', 'feed must be an at:// URI')
    }
    const expectedDid = await publisherDid()
    if (uri.collection !== FEED_COLLECTION || (expectedDid && uri.host !== expectedDid) || !engine.feed(uri.rkey)) {
      return xrpcError(400, 'UnknownFeed', `Unknown feed: ${feedParam}`)
    }

    const limitParam = Number.parseInt(c.req.query('limit') ?? '50', 10)
    const limit = Number.isFinite(limitParam) ? Math.min(100, Math.max(1, limitParam)) : 50
    try {
      const page = await engine.skeleton(uri.rkey, { limit, cursor: c.req.query('cursor') || undefined })
      c.header('cache-control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=60')
      return c.json(page)
    } catch (err) {
      if (err instanceof FeedError && err.code === 'BadCursor') return xrpcError(400, 'InvalidRequest', err.message)
      console.error(`getFeedSkeleton ${uri.rkey} failed:`, err)
      return xrpcError(502, 'FeedUnavailable', 'This feed is temporarily unavailable')
    }
  })

  app.get('/', async (c) => {
    const hostname = config.hostname
    return c.html(
      dashboardPage(engine.feeds, {
        hostname,
        serviceDid: config.serviceDid ?? (hostname ? `did:web:${hostname}` : undefined),
        publisherDid: await publisherDid(),
        hasCredentials: bsky.hasCredentials,
        needsCredentials: engine.feeds.some((f) => f.sources.some((s) => s.type === 'search' || s.type === 'likes')),
      }),
    )
  })

  app.get('/feeds/:id', async (c) => {
    const feed = engine.feed(c.req.param('id'))
    if (!feed) return c.html(errorPage('Not found', `There's no feed with id "${c.req.param('id')}".`), 404)
    try {
      return c.html(previewPage(feed, await engine.preview(feed.id)))
    } catch (err) {
      return c.html(errorPage(feed.displayName, err instanceof Error ? err.message : String(err)), 502)
    }
  })

  app.get('/playground', (c) => c.html(playgroundPage(Boolean(config.adminToken))))

  // Builds an ad-hoc feed definition so it can be tried before committing it. Bypasses the cache.
  app.post('/api/preview', async (c) => {
    const asHtml = c.req.query('format') === 'html'
    const fail = (status: 400 | 401 | 403 | 502, message: string) =>
      asHtml ? c.html(html`<div class="notice error">${message}</div>`, status) : c.json({ error: message }, status)

    if (!config.adminToken) return fail(403, 'The playground is disabled. Set ADMIN_TOKEN to enable it.')
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (!sameSecret(token, config.adminToken)) return fail(401, 'Wrong admin token.')

    let feed
    try {
      feed = parseFeed(await c.req.json())
    } catch (err) {
      const message = err instanceof FeedValidationError ? err.message : `Invalid JSON: ${err instanceof Error ? err.message : err}`
      return fail(400, message)
    }
    try {
      const result = await engine.hydrate(await engine.build(feed))
      return asHtml ? c.html(previewFragment(result)) : c.json(result)
    } catch (err) {
      return fail(502, err instanceof Error ? err.message : String(err))
    }
  })

  return app
}
