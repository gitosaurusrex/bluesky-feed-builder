import type { Agent } from '@atproto/api'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppDeps, ManageDeps, RouteHelpers } from './app.js'
import { LOGIN_COOKIE, Logins, isLocalHostname } from './auth.js'
import { FeedValidationError, parseFeed } from './feeds/define.js'
import {
  type AvatarChange,
  type GeneratorRecord,
  feedUrl,
  listGeneratorRecords,
  publishFeed,
  publishStatus,
  unpublishFeed,
  withPublicStatus,
} from './publish.js'
import { type ImportInput, type SkyfeedBuilder, convertSkyfeed, parseImport } from './feeds/skyfeed.js'
import { type LooseFeed, NEW_FEED, editorPage, formToDefinition } from './web/editor.js'
import type { Viewer } from './web/layout.js'
import { type DashboardModel, dashboardPage, errorPage, importPage, loginPage, publishPage } from './web/views.js'
import { setupWarnings } from './warnings.js'

const MAX_AVATAR_BYTES = 1_000_000
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg'])
/** Paths the editor uses, which can't double as feed ids. */
const RESERVED_IDS = new Set(['new', 'import'])

/** Messages shown on the dashboard after an action. Codes rather than text, so links can't inject messages. */
const DONE: Record<string, (feed: string) => string> = {
  'signed-in': () => 'Signed in.',
  'signed-out': () => 'Signed out.',
  created: (f) => `Created ${f}. Publish it to add it to your Bluesky profile.`,
  saved: (f) => `Saved ${f}. Changes show up in Bluesky within a minute.`,
  published: (f) => `Published ${f}. It's on your Bluesky profile now.`,
  unpublished: (f) => `Removed ${f} from Bluesky.`,
  deleted: (f) => `Deleted ${f}.`,
}

type Deps = AppDeps & { manage: ManageDeps }

export function registerManageRoutes(app: Hono, deps: Deps, helpers: RouteHelpers): void {
  const { config, engine, bsky, manage } = deps
  const { db, registry, logins } = manage

  const viewer = (signedIn: boolean): Viewer => ({ signedIn, canSignIn: true })
  const local = isLocalHostname(config.hostname)

  /** Owner-only pages. Everyone else is sent to the sign-in page. */
  const requireOwner: MiddlewareHandler = async (c, next) => {
    if (await helpers.ownerOf(c)) return next()
    if (c.req.method === 'GET') return c.redirect('/login')
    return c.html(errorPage('Sign in required', 'Sign in to make changes.', viewer(false)), 401)
  }

  /** The owner's Bluesky session for writing to their repo. Missing if it was revoked or expired. */
  const repoAgent = async (): Promise<Agent> => {
    const did = await bsky.ownerDid()
    const agent = did ? await (await manage.auth()).repoAgent(did) : undefined
    if (!agent) throw new Error('Your Bluesky session has expired. Sign out and sign in again.')
    return agent
  }

  /** Publishing from a laptop would point the feed at localhost, which Bluesky can't reach. */
  const publishBlocked = (req: Request) =>
    isLocalHostname(helpers.hostnameOf(req))
      ? "Feeds can't be published from a local server, because Bluesky has to reach this service over the internet. Publish from your deployed dashboard, or with npm run publish-feeds."
      : undefined

  const loginCookie = (c: Context, token: string) =>
    setCookie(c, LOGIN_COOKIE, token, { httpOnly: true, secure: !local, sameSite: 'Lax', path: '/', maxAge: Logins.maxAgeSeconds })

  // --- Sign-in ---

  app.get('/client-metadata.json', async (c) => c.json((await manage.auth()).client.clientMetadata))
  app.get('/oauth/jwks.json', async (c) => c.json((await manage.auth()).client.jwks))

  app.get('/login', async (c) => {
    if (await helpers.ownerOf(c)) return c.redirect('/')
    // Bluesky's development client only redirects to 127.0.0.1, and cookies don't carry over from localhost.
    const url = new URL(c.req.url)
    if (local && url.hostname === 'localhost') return c.redirect(`http://127.0.0.1:${url.port || config.port}/login`)
    const owner = config.bsky.identifier ?? (await bsky.ownerDid())
    const setupProblem = (await bsky.ownerDid())
      ? undefined
      : 'Set BSKY_IDENTIFIER to your Bluesky handle so Feed Builder knows whose dashboard this is.'
    return c.html(loginPage(viewer(false), { owner: owner ? `@${owner.replace(/^@/, '')}` : undefined, setupProblem }))
  })

  app.post('/login', async (c) => {
    const owner = await bsky.ownerDid()
    if (!owner) return c.redirect('/login')
    try {
      const url = await (await manage.auth()).client.authorize(owner)
      return c.redirect(url.toString())
    } catch (err) {
      console.error('Starting sign-in failed:', err)
      return c.html(loginPage(viewer(false), { error: `Couldn't start sign-in: ${messageOf(err)}` }), 502)
    }
  })

  app.get('/oauth/callback', async (c) => {
    const auth = await manage.auth()
    let did: string
    try {
      did = (await auth.client.callback(new URL(c.req.url).searchParams)).session.did
    } catch (err) {
      console.error('Sign-in callback failed:', err)
      return c.html(loginPage(viewer(false), { error: `Sign-in didn't complete: ${messageOf(err)}` }), 400)
    }
    const owner = await bsky.ownerDid()
    if (did !== owner) {
      await auth.client.revoke(did).catch(() => {})
      return c.html(loginPage(viewer(false), { error: 'That account isn\'t the owner of this Feed Builder. Only the account in BSKY_IDENTIFIER can sign in.' }), 403)
    }
    loginCookie(c, await logins.create(did))
    return c.redirect('/?done=signed-in')
  })

  app.post('/logout', async (c) => {
    // Only the dashboard login ends; the Bluesky session stays, so search feeds keep working.
    await logins.delete(getCookie(c, LOGIN_COOKIE))
    deleteCookie(c, LOGIN_COOKIE, { path: '/' })
    return c.redirect('/?done=signed-out')
  })

  // --- Dashboard ---

  app.get('/', async (c) => {
    const owner = await helpers.ownerOf(c)
    const snapshot = await registry.snapshot()
    const serviceDid = helpers.serviceDidOf(c.req.raw)
    const model: DashboardModel = {
      viewer: viewer(Boolean(owner)),
      feeds: snapshot.feeds.map(({ def, origin }) => ({ def, origin })),
      serviceDid,
      publisherDid: await bsky.ownerDid(),
      warnings: setupWarnings(deps, snapshot.feeds.map((f) => f.def)),
      broken: snapshot.broken,
      orphans: [],
      editable: true,
      messages: [],
      external: [],
    }

    const done = DONE[c.req.query('done') ?? '']
    if (done) model.messages.push({ text: done(c.req.query('feed') ?? 'the feed'), kind: 'ok' })

    if (owner) {
      try {
        const records = await listGeneratorRecords(await repoAgent())
        for (const feed of model.feeds) feed.status = publishStatus(feed.def, records.get(feed.def.id), serviceDid)
        const known = new Set(model.feeds.map((f) => f.def.id))
        model.orphans = [...records].filter(([id, r]) => r.did === serviceDid && !known.has(id)).map(([id]) => id)
        model.external = [...records]
          .filter(([id, r]) => r.did !== serviceDid && !known.has(id))
          .map(([id, r]) => ({ id, displayName: r.displayName, service: r.did, importable: Boolean(r.skyfeedBuilder) }))
      } catch (err) {
        model.messages.push({ text: `Couldn't load your published feeds: ${messageOf(err)}`, kind: 'error' })
      }
    } else {
      model.feeds = await withPublicStatus(bsky, model.feeds, model.publisherDid, serviceDid)
    }
    return c.html(dashboardPage(model))
  })

  // --- Editor ---

  /** Validates an editor submission. Returns an error message, or the definition to save. */
  const validate = async (input: LooseFeed, isNew: boolean): Promise<{ error: string } | { feed: LooseFeed }> => {
    try {
      parseFeed(input)
    } catch (err) {
      if (err instanceof FeedValidationError) return { error: err.message }
      throw err
    }
    const id = String(input.id)
    if (isNew && (RESERVED_IDS.has(id) || registry.isCodeFeed(id) || (await db.getFeed(id)))) {
      return { error: `There's already a feed with the id "${id}". Pick another.` }
    }
    return { feed: input }
  }

  app.get('/feeds/new', requireOwner, (c) => c.html(editorPage({ viewer: viewer(true), mode: 'new', feed: NEW_FEED })))

  // --- Import ---

  /**
   * Turns an import into a feed for the editor. A feed from the owner's own repo
   * keeps its id, so that publishing it moves the existing feed here.
   */
  const importFeed = async (input: ImportInput): Promise<{ feed: LooseFeed; notes: string[] }> => {
    if (input.kind === 'feed') return { feed: input.feed, notes: [] }

    let builder: SkyfeedBuilder
    let record: { displayName?: string; description?: string } | undefined
    let rkey: string | undefined
    if (input.kind === 'link') {
      const uri = await bsky.toAtUri(input.uri, 'app.bsky.feed.generator')
      const value = await bsky.getRecord(uri)
      if (!value.skyfeedBuilder || typeof value.skyfeedBuilder !== 'object') {
        throw new Error("That feed doesn't include SkyFeed settings, so there's nothing to import. Recreate it with New feed.")
      }
      builder = value.skyfeedBuilder as SkyfeedBuilder
      record = { displayName: value.displayName as string | undefined, description: value.description as string | undefined }
      const [, did, , id] = uri.split('/').slice(1)
      if (did === (await bsky.ownerDid())) rkey = id
    } else {
      builder = input.builder
      record = input.record
    }

    const { feed, notes } = convertSkyfeed(builder)
    if (record?.displayName) feed.displayName = record.displayName.slice(0, 24)
    if (record?.description) feed.description = record.description.slice(0, 300)
    if (rkey) {
      const taken = RESERVED_IDS.has(rkey) || registry.isCodeFeed(rkey) || (await db.getFeed(rkey))
      if (!/^[a-z0-9][a-z0-9-]{0,14}$/.test(rkey) || taken) {
        notes.push(`Your existing feed's id "${rkey}" can't be reused here, so this will be published as a new feed.`)
      } else {
        feed.id = rkey
        notes.push('Saving keeps the id of your existing feed. Publishing it afterwards moves that feed here, keeping its link, likes and pins.')
      }
    } else if (input.kind === 'link') {
      notes.push("This feed belongs to someone else, so publishing creates a new feed on your profile. Pick an id below.")
    }
    return { feed, notes }
  }

  const showImport = async (c: Context, input: ImportInput, text?: string) => {
    try {
      const { feed, notes } = await importFeed(input)
      return c.html(editorPage({ viewer: viewer(true), mode: 'new', feed, notes }))
    } catch (err) {
      return c.html(importPage(viewer(true), { text, error: messageOf(err) }), 400)
    }
  }

  app.get('/feeds/import', requireOwner, async (c) => {
    const from = c.req.query('from')
    if (!from) return c.html(importPage(viewer(true)))
    const owner = (await bsky.ownerDid())!
    return showImport(c, { kind: 'link', uri: `at://${owner}/app.bsky.feed.generator/${from}` })
  })

  app.post('/feeds/import', requireOwner, async (c) => {
    const text = String((await c.req.formData()).get('text') ?? '')
    let input: ImportInput
    try {
      input = parseImport(text)
    } catch (err) {
      return c.html(importPage(viewer(true), { text, error: messageOf(err) }), 400)
    }
    return showImport(c, input, text)
  })

  app.post('/feeds/new', requireOwner, async (c) => {
    const input = formToDefinition(await c.req.formData())
    const result = await validate(input, true)
    if ('error' in result) return c.html(editorPage({ viewer: viewer(true), mode: 'new', feed: input, error: result.error }), 400)
    await db.createFeed(String(input.id), result.feed)
    registry.invalidate()
    return c.redirect(`/?done=created&feed=${encodeURIComponent(String(input.displayName))}`)
  })

  app.get('/feeds/:id/edit', requireOwner, async (c) => {
    const id = c.req.param('id')
    if (registry.isCodeFeed(id)) {
      return c.html(errorPage('Defined in code', `"${id}" is defined in feeds/. Edit it there and redeploy.`, viewer(true)), 400)
    }
    const stored = await db.getFeed(id)
    if (!stored) return c.html(errorPage('Not found', `There's no saved feed with id "${id}".`, viewer(true)), 404)
    return c.html(editorPage({ viewer: viewer(true), mode: 'edit', feed: { ...(stored.definition as LooseFeed), id } }))
  })

  app.post('/feeds/:id/edit', requireOwner, async (c) => {
    const id = c.req.param('id')
    if (!(await db.getFeed(id))) return c.html(errorPage('Not found', `There's no saved feed with id "${id}".`, viewer(true)), 404)
    const input: LooseFeed = { ...formToDefinition(await c.req.formData()), id }
    const result = await validate(input, false)
    if ('error' in result) return c.html(editorPage({ viewer: viewer(true), mode: 'edit', feed: input, error: result.error }), 400)
    await db.updateFeed(id, result.feed)
    registry.invalidate()
    return c.redirect(`/?done=saved&feed=${encodeURIComponent(String(input.displayName))}`)
  })

  app.post('/feeds/:id/delete', requireOwner, async (c) => {
    const id = c.req.param('id')
    const stored = await db.getFeed(id)
    if (!stored) return c.redirect('/')
    try {
      const agent = await repoAgent()
      const record = (await listGeneratorRecords(agent)).get(id)
      // Unpublish first; a published feed with nothing behind it just shows an error in Bluesky.
      if (record?.did === helpers.serviceDidOf(c.req.raw)) await unpublishFeed(agent, id)
    } catch (err) {
      return c.html(errorPage('Delete failed', `Couldn't remove "${id}" from Bluesky, so it wasn't deleted: ${messageOf(err)}`, viewer(true)), 502)
    }
    await db.deleteFeed(id)
    registry.invalidate()
    return c.redirect(`/?done=deleted&feed=${encodeURIComponent(id)}`)
  })

  // --- Publishing ---

  const publishContext = async (c: Context) => {
    const id = c.req.param('id')!
    const feed = await engine.feed(id)
    const agent = await repoAgent()
    const record: GeneratorRecord | undefined = (await listGeneratorRecords(agent)).get(id)
    const status = feed ? publishStatus(feed, record, helpers.serviceDidOf(c.req.raw)) : 'unpublished'
    return { id, feed, agent, record, status }
  }

  app.get('/feeds/:id/publish', requireOwner, async (c) => {
    try {
      const { feed, record, status, agent } = await publishContext(c)
      if (!feed) return c.html(errorPage('Not found', `There's no feed with id "${c.req.param('id')}".`, viewer(true)), 404)
      return c.html(
        publishPage(feed, {
          viewer: viewer(true),
          status,
          hasAvatar: Boolean(record?.avatar),
          feedLink: feedUrl(agent.assertDid, feed.id),
          blocked: publishBlocked(c.req.raw),
          currentService: status === 'elsewhere' ? record?.did : undefined,
        }),
      )
    } catch (err) {
      return c.html(errorPage('Publish', messageOf(err), viewer(true)), 502)
    }
  })

  app.post('/feeds/:id/publish', requireOwner, async (c) => {
    const form = await c.req.formData()
    let ctx
    try {
      ctx = await publishContext(c)
    } catch (err) {
      return c.html(errorPage('Publish', messageOf(err), viewer(true)), 502)
    }
    const { feed, record, status, agent } = ctx
    if (!feed) return c.html(errorPage('Not found', `There's no feed with id "${ctx.id}".`, viewer(true)), 404)
    const fail = (error: string) =>
      c.html(
        publishPage(feed, {
          viewer: viewer(true),
          status,
          hasAvatar: Boolean(record?.avatar),
          error,
          currentService: status === 'elsewhere' ? record?.did : undefined,
        }),
        400,
      )

    const blocked = publishBlocked(c.req.raw)
    if (blocked) return fail(blocked)
    // Taking over a feed another service runs changes what its followers see, so it needs an explicit yes.
    if (status === 'elsewhere' && !form.get('takeover')) return fail('Tick the box to confirm moving this feed here.')

    let avatar: AvatarChange = form.get('removeAvatar') ? 'remove' : 'keep'
    const file = form.get('avatar')
    if (file instanceof File && file.size > 0) {
      if (!AVATAR_TYPES.has(file.type)) return fail('The avatar has to be a PNG or JPEG.')
      if (file.size > MAX_AVATAR_BYTES) return fail('The avatar has to be under 1 MB.')
      avatar = { bytes: new Uint8Array(await file.arrayBuffer()), encoding: file.type }
    }

    try {
      await publishFeed(agent, { feed, serviceDid: helpers.serviceDidOf(c.req.raw), previous: record, avatar })
    } catch (err) {
      return fail(`Publishing failed: ${messageOf(err)}`)
    }
    return c.redirect(`/?done=published&feed=${encodeURIComponent(feed.displayName)}`)
  })

  app.post('/feeds/:id/unpublish', requireOwner, async (c) => {
    const id = c.req.param('id')
    try {
      const agent = await repoAgent()
      const record = (await listGeneratorRecords(agent)).get(id)
      // Never delete a record that belongs to some other feed service.
      if (record && record.did !== helpers.serviceDidOf(c.req.raw)) {
        return c.html(errorPage('Unpublish', `"${id}" is served by ${record.did}, not this service, so it was left alone.`, viewer(true)), 400)
      }
      if (record) await unpublishFeed(agent, id)
    } catch (err) {
      return c.html(errorPage('Unpublish', messageOf(err), viewer(true)), 502)
    }
    return c.redirect(`/?done=unpublished&feed=${encodeURIComponent(id)}`)
  })
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
