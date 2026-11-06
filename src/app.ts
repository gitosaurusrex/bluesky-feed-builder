import { createHash, timingSafeEqual } from 'node:crypto'
import { AtUri } from '@atproto/api'
import { type Context, Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { csrf } from 'hono/csrf'
import { html } from 'hono/html'
import { LOGIN_COOKIE, type Logins, type OwnerAuth } from './auth.js'
import type { FeedRestorer } from './backup.js'
import type { Bsky } from './bsky.js'
import type { Config } from './config.js'
import type { Database } from './db.js'
import { FeedValidationError, parseFeed } from './feeds/define.js'
import { FeedEngine, FeedError } from './feeds/engine.js'
import type { CombinedRegistry } from './feeds/registry.js'
import { registerManageRoutes } from './manage.js'
import { FEED_COLLECTION, withPublicStatus } from './publish.js'
import { formToDefinition } from './web/editor.js'
import { FAVICON, type Viewer } from './web/layout.js'
import { dashboardPage, errorPage, playgroundPage, previewFragment, previewPage } from './web/views.js'
import { setupWarnings } from './warnings.js'

/** Present when a database is configured: sign-in, the editor and publishing from the dashboard. */
export interface ManageDeps {
  db: Database
  registry: CombinedRegistry
  logins: Logins
  /** Created on first use, since it needs the database and may import a key. */
  auth: () => Promise<OwnerAuth>
  /** Rebuilds feeds from the backups in their Bluesky records when the database doesn't have them. */
  restorer: FeedRestorer
  /** A short, non-secret fingerprint of the database address, to spot a database being swapped. */
  databaseId: string
  /** Where the database lives (host name, or file path), shown to the owner. Never includes the auth token. */
  databaseHost: string
}

export interface AppDeps {
  config: Config
  engine: FeedEngine
  bsky: Bsky
  manage?: ManageDeps
}

/** Helpers shared by the route modules. */
export interface RouteHelpers {
  hostnameOf(req: Request): string
  serviceDidOf(req: Request): string
  /** The signed-in owner's DID, if the request carries a valid login. */
  ownerOf(c: Context): Promise<string | undefined>
  viewerOf(c: Context): Promise<Viewer>
}


function sameSecret(a: string, b: string): boolean {
  const hash = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(hash(a), hash(b))
}

export function createApp(deps: AppDeps): Hono {
  const { config, engine, bsky, manage } = deps
  const app = new Hono()

  const hostnameOf = (req: Request) => config.hostname ?? req.headers.get('x-forwarded-host') ?? new URL(req.url).host
  const serviceDidOf = (req: Request) => config.serviceDid ?? `did:web:${hostnameOf(req)}`

  const ownerOf = async (c: Context): Promise<string | undefined> => {
    if (!manage) return undefined
    const did = await manage.logins.get(getCookie(c, LOGIN_COOKIE))
    return did && did === (await bsky.ownerDid()) ? did : undefined
  }
  const viewerOf = async (c: Context): Promise<Viewer> => ({ signedIn: Boolean(await ownerOf(c)), canSignIn: Boolean(manage) })
  const helpers: RouteHelpers = { hostnameOf, serviceDidOf, ownerOf, viewerOf }

  // Browsers send Origin on form posts; compare hosts, since proxies may hide the original scheme.
  app.use(csrf({ origin: (origin, c) => URL.canParse(origin) && new URL(origin).host === hostnameOf(c.req.raw) }))

  const xrpcError = (status: 400 | 401 | 500 | 502, error: string, message: string) =>
    new Response(JSON.stringify({ error, message }), { status, headers: { 'content-type': 'application/json' } })

  app.get('/health', async (c) => {
    const feeds = (await engine.feeds()).length
    if (!manage) return c.json({ ok: true, feeds, database: null })
    // The address fingerprint changes if the setting does; the creation time changes if the database is new or emptied.
    const database = await manage.db
      .getOrCreate('config', 'database-created', async () => new Date().toISOString())
      .then((createdAt) => ({ id: manage.databaseId, createdAt }))
      .catch((err: unknown) => ({ id: manage.databaseId, error: err instanceof Error ? err.message : String(err) }))
    return c.json({ ok: true, feeds, database })
  })
  app.get('/favicon.svg', (c) => c.body(FAVICON, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }))
  app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'))

  // Registered before /feeds/:id so that /feeds/new isn't taken for a feed called "new".
  if (manage) registerManageRoutes(app, { ...deps, manage }, helpers)

  // The DID document that lets Bluesky find this service when it's identified by did:web.
  app.get('/.well-known/did.json', (c) => {
    const did = serviceDidOf(c.req.raw)
    if (!did.startsWith('did:web:')) return c.notFound()
    return c.json({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did,
      service: [{ id: '#bsky_fg', type: 'BskyFeedGenerator', serviceEndpoint: `https://${hostnameOf(c.req.raw)}` }],
    })
  })

  app.get('/xrpc/app.bsky.feed.describeFeedGenerator', async (c) => {
    const did = await bsky.ownerDid()
    const feeds = await engine.feeds()
    return c.json({
      did: serviceDidOf(c.req.raw),
      feeds: did ? feeds.map((f) => ({ uri: `at://${did}/${FEED_COLLECTION}/${f.id}` })) : [],
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
    const expectedDid = await bsky.ownerDid()
    if (uri.collection !== FEED_COLLECTION || (expectedDid && uri.host !== expectedDid)) {
      return xrpcError(400, 'UnknownFeed', `Unknown feed: ${feedParam}`)
    }
    if (!(await engine.feed(uri.rkey))) {
      // A published feed the database doesn't know, e.g. after the database was swapped: rebuild it from its record.
      const restored = manage && expectedDid ? await manage.restorer.restore(expectedDid, uri.rkey, serviceDidOf(c.req.raw)) : false
      if (!restored || !(await engine.feed(uri.rkey))) return xrpcError(400, 'UnknownFeed', `Unknown feed: ${feedParam}`)
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

  app.get('/feeds/:id', async (c) => {
    const viewer = await viewerOf(c)
    const feed = await engine.feed(c.req.param('id'))
    if (!feed) return c.html(errorPage('Not found', `There's no feed with id "${c.req.param('id')}".`, viewer), 404)
    try {
      return c.html(previewPage(feed, await engine.preview(feed.id), viewer))
    } catch (err) {
      return c.html(errorPage(feed.displayName, err instanceof Error ? err.message : String(err), viewer), 502)
    }
  })

  app.get('/playground', async (c) => c.html(playgroundPage(await viewerOf(c), { tokenEnabled: Boolean(config.adminToken) })))

  // Builds a feed definition that isn't saved, for the editor and playground. Bypasses the cache.
  app.post('/api/preview', async (c) => {
    const asHtml = c.req.query('format') === 'html'
    const fail = (status: 400 | 401 | 403 | 502, message: string) =>
      asHtml ? c.html(html`<div class="notice error">${message}</div>`, status) : c.json({ error: message }, status)

    if (!(await ownerOf(c))) {
      if (!config.adminToken) return fail(403, manage ? 'Sign in to preview feeds.' : 'Set ADMIN_TOKEN to enable the playground.')
      const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
      if (!sameSecret(token, config.adminToken)) return fail(401, 'Wrong admin token.')
    }

    let feed
    try {
      const type = c.req.header('content-type') ?? ''
      const input = /multipart\/form-data|x-www-form-urlencoded/.test(type)
        ? formToDefinition(await c.req.formData())
        : await c.req.json()
      // The editor's preview runs before an id is chosen.
      feed = parseFeed({ id: 'preview', displayName: 'Preview', ...input })
    } catch (err) {
      const message = err instanceof FeedValidationError ? err.message : `Invalid JSON: ${err instanceof Error ? err.message : err}`
      return fail(400, message)
    }
    try {
      const result = await engine.hydrate(await engine.build(feed, { readOnly: true }))
      return asHtml ? c.html(previewFragment(result)) : c.json(result)
    } catch (err) {
      return fail(502, err instanceof Error ? err.message : String(err))
    }
  })

  if (!manage) {
    app.get('/', async (c) => {
      const feeds = await engine.feeds()
      const publisherDid = await bsky.ownerDid()
      const serviceDid = serviceDidOf(c.req.raw)
      return c.html(
        dashboardPage({
          viewer: { signedIn: false, canSignIn: false },
          feeds: await withPublicStatus(
            bsky,
            feeds.map((def) => ({ def, origin: 'code' as const })),
            publisherDid,
            serviceDid,
          ),
          serviceDid,
          publisherDid,
          warnings: setupWarnings(deps, feeds),
          broken: [],
          orphans: [],
          editable: false,
          messages: [],
          external: [],
        }),
      )
    })
  }

  return app
}
