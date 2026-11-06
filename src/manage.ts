import type { Agent } from '@atproto/api'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppDeps, ManageDeps, RouteHelpers } from './app.js'
import { LOGIN_COOKIE, Logins, isLocalHostname } from './auth.js'
import { BACKUP_FIELD, backupOf, makeBackup, syncBackup } from './backup.js'
import { feedKey } from './db.js'
import { FeedValidationError, parseFeed } from './feeds/define.js'
import { type ImportInput, type SkyfeedBuilder, convertSkyfeed, parseImport, sameBuilder } from './feeds/skyfeed.js'
import {
  type AvatarChange,
  type GeneratorRecord,
  avatarUrl,
  feedUrl,
  listGeneratorRecords,
  publishFeed,
  publishStatus,
  unpublishFeed,
} from './publish.js'
import { type LooseFeed, NEW_FEED, editorPage, formToDefinition, slugify } from './web/editor.js'
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
  created: (f) => `Created ${f}. Publish it to add it to your Bluesky profile.`,
  saved: (f) => `Saved ${f}. Changes show up in Bluesky within a minute.`,
  published: (f) => `Published ${f}. It's on your Bluesky profile now.`,
  unpublished: (f) => `Removed ${f} from Bluesky.`,
  deleted: (f) => `Deleted ${f}.`,
}

type Deps = AppDeps & { manage: ManageDeps }

export function registerManageRoutes(app: Hono, deps: Deps, helpers: RouteHelpers): void {
  const { config, engine, bsky, manage } = deps
  const { db, registry, logins, members } = manage

  const viewer = (signedIn: boolean): Viewer => ({ signedIn, canSignIn: true })
  const local = isLocalHostname(config.hostname)

  /** Members' pages. Everyone else is sent to the sign-in page. */
  const users = new WeakMap<Request, { did: string; viewer: Viewer }>()
  const requireMember: MiddlewareHandler = async (c, next) => {
    const did = await helpers.userOf(c)
    if (did) {
      users.set(c.req.raw, { did, viewer: await helpers.viewerFor(did) })
      return next()
    }
    if (c.req.method === 'GET') return c.redirect('/login')
    return c.html(errorPage('Sign in required', 'Sign in to make changes.', viewer(false)), 401)
  }
  /** The signed-in member, on routes behind requireMember. */
  const userIn = (c: Context): string => users.get(c.req.raw)!.did
  /** The signed-in member as the page header shows them, on routes behind requireMember. */
  const me = (c: Context): Viewer => users.get(c.req.raw)!.viewer

  /** A member's Bluesky session for writing to their repo. Missing if it was revoked or expired. */
  const repoAgent = async (did: string): Promise<Agent> => {
    const agent = await (await manage.auth()).repoAgent(did)
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

  const notInvited = (who: string) =>
    `${who} hasn't been invited to this Blue Feeds. Ask its owner to add the handle to ALLOWED_ACCOUNTS.`

  // --- Sign-in ---

  app.get('/client-metadata.json', async (c) => c.json((await manage.auth()).client.clientMetadata))
  app.get('/oauth/jwks.json', async (c) => c.json((await manage.auth()).client.jwks))

  const setupProblem = async () =>
    (await bsky.ownerDid()) ? undefined : 'Set BSKY_IDENTIFIER to your Bluesky handle so Blue Feeds knows who runs it.'

  // Visitors who aren't signed in only ever see the welcome page; no feeds are listed until they sign in.
  const welcome = async (c: Context) => {
    // Bluesky's development client only redirects to 127.0.0.1, and cookies don't carry over from localhost.
    const url = new URL(c.req.url)
    if (local && url.hostname === 'localhost') return c.redirect(`http://127.0.0.1:${url.port || config.port}${url.pathname}${url.search}`)
    const signedOut = c.req.query('done') === 'signed-out'
    return c.html(loginPage(viewer(false), { setupProblem: await setupProblem(), message: signedOut ? 'You signed out. See you soon!' : undefined }))
  }

  app.get('/login', async (c) => ((await helpers.userOf(c)) ? c.redirect('/') : welcome(c)))

  app.post('/login', async (c) => {
    const problem = await setupProblem()
    if (problem) return c.html(loginPage(viewer(false), { setupProblem: problem }), 400)
    const handle = String((await c.req.formData()).get('handle') ?? '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase()
    const retry = (status: 400 | 403 | 502, error: string) => c.html(loginPage(viewer(false), { handle, error }), status)
    if (!handle) return retry(400, 'Enter your Bluesky handle, like you.bsky.social.')

    // Check the invitation before sending anyone off to Bluesky.
    let did: string
    try {
      did = await bsky.resolveDid(handle)
    } catch {
      return retry(400, `Couldn't find the Bluesky account @${handle}. Check the spelling.`)
    }
    if (!(await members.has(did))) return retry(403, notInvited(`@${handle}`))
    try {
      const url = await (await manage.auth()).client.authorize(handle)
      return c.redirect(url.toString())
    } catch (err) {
      console.error('Starting sign-in failed:', err)
      return retry(502, `Couldn't start sign-in: ${messageOf(err)}`)
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
    if (!(await members.has(did))) {
      await auth.client.revoke(did).catch(() => {})
      return c.html(loginPage(viewer(false), { error: notInvited('That account') }), 403)
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
    const user = await helpers.userOf(c)
    if (!user) return welcome(c)
    // Members see only their own feeds.
    const mine = async () => {
      const snapshot = await registry.snapshot()
      return {
        feeds: snapshot.feeds.filter((f) => f.owner === user).map(({ def, origin }) => ({ def, origin })),
        broken: snapshot.broken.filter((b) => b.owner === user),
      }
    }
    const { feeds, broken } = await mine()
    const serviceDid = helpers.serviceDidOf(c.req.raw)
    const model: DashboardModel = {
      viewer: await helpers.viewerFor(user),
      feeds,
      serviceDid,
      publisherDid: user,
      warnings: setupWarnings(deps, feeds.map((f) => f.def)),
      broken,
      orphans: [],
      editable: true,
      messages: [],
      external: [],
    }

    const done = DONE[c.req.query('done') ?? '']
    if (done) model.messages.push({ text: done(c.req.query('feed') ?? 'the feed'), kind: 'ok' })

    const since = await db.getOrCreate('config', 'database-created', async () => new Date().toISOString()).catch(() => undefined)
    model.database = { host: manage.databaseHost, since: since ? `${since.replace('T', ' ').slice(0, 16)} UTC` : undefined }
    try {
      const records = await listGeneratorRecords(await repoAgent(user))
      const missing = [...records].filter(([id, r]) => r.did === serviceDid && !model.feeds.some((f) => f.def.id === id))
      const restored: string[] = []
      for (const [id, record] of missing) {
        const ok = await manage.restorer
          .restoreFrom(user, id, record as unknown as Record<string, unknown>, serviceDid)
          .catch((err) => (console.error(`Restoring "${id}" failed:`, err), false))
        if (ok) restored.push(record.displayName || id)
      }
      if (restored.length) {
        Object.assign(model, await mine())
        model.messages.push({ text: `Restored ${restored.join(', ')} from the backup in Bluesky.`, kind: 'ok' })
      }
      for (const feed of model.feeds) {
        const record = records.get(feed.def.id)
        feed.status = publishStatus(feed.def, record, serviceDid)
        feed.avatar = avatarUrl(user, record?.avatar)
      }
      const known = new Set(model.feeds.map((f) => f.def.id))
      model.orphans = [...records]
        .filter(([id, r]) => r.did === serviceDid && !known.has(id))
        .map(([id, r]) => ({ id, displayName: r.displayName }))
      model.external = [...records]
        .filter(([id, r]) => r.did !== serviceDid && !known.has(id))
        .map(([id, r]) => ({ id, displayName: r.displayName, service: r.did, importable: Boolean(r.skyfeedBuilder) }))
    } catch (err) {
      model.messages.push({ text: `Couldn't load your published feeds: ${messageOf(err)}`, kind: 'error' })
    }
    return c.html(dashboardPage(model))
  })

  // --- Editor ---

  /** Updates the backup in a published feed's record. A failure only means the backup is older; it never blocks a save. */
  const refreshBackup = async (c: Context, user: string, id: string, definition: LooseFeed) => {
    try {
      await syncBackup(await repoAgent(user), id, definition, helpers.serviceDidOf(c.req.raw))
    } catch (err) {
      console.error(`Updating the backup of "${id}" failed:`, err)
    }
  }

  const isTaken = async (user: string, id: string) =>
    RESERVED_IDS.has(id) || (await registry.isCodeFeed(user, id)) || Boolean(await db.getFeed(user, id))

  /** `base`, or `base-2`, `base-3`… if that's taken, kept within the 15-character limit. */
  const freeId = async (user: string, base: string): Promise<string | undefined> => {
    if (!base) return undefined
    for (let n = 1; n < 100; n++) {
      const suffix = n === 1 ? '' : `-${n}`
      const id = base.slice(0, 15 - suffix.length).replace(/-+$/, '') + suffix
      if (!(await isTaken(user, id))) return id
    }
    return undefined
  }

  /** Validates an editor submission. Returns an error message, or the definition to save. */
  const validate = async (user: string, input: LooseFeed, isNew: boolean): Promise<{ error: string } | { feed: LooseFeed }> => {
    try {
      parseFeed(input)
    } catch (err) {
      if (err instanceof FeedValidationError) return { error: err.message }
      throw err
    }
    const id = String(input.id)
    if (isNew && (await isTaken(user, id))) return { error: `There's already a feed with the id "${id}". Pick another.` }
    return { feed: input }
  }

  app.get('/feeds/new', requireMember, (c) => c.html(editorPage({ viewer: me(c), mode: 'new', feed: NEW_FEED })))

  // --- Import ---

  /**
   * Turns an import into a feed for the editor. A feed from the member's own
   * repo keeps its id, so that publishing it moves the existing feed here.
   */
  const importFeed = async (user: string, input: ImportInput): Promise<{ feed: LooseFeed; notes: string[] }> => {
    if (input.kind === 'feed') return { feed: input.feed, notes: [] }

    let builder: SkyfeedBuilder
    let record: { displayName?: string; description?: string } | undefined
    let rkey: string | undefined
    let foreign = false
    const ownRkey = (uri: string) => {
      const [, did, , id] = uri.split('/').slice(1)
      if (did === user) rkey = id
      else foreign = true
    }
    if (input.kind === 'link') {
      const uri = await bsky.toAtUri(input.uri, 'app.bsky.feed.generator')
      const value = await bsky.getRecord(uri)
      const [, did, , id] = uri.split('/').slice(1)
      const backup = backupOf(value)
      if (backup) {
        const own = did === user && id && !(await isTaken(user, id))
        const feed: LooseFeed = { ...backup, id: own ? id : undefined }
        if (!feed.id && typeof feed.displayName === 'string') feed.id = await freeId(user, slugify(feed.displayName))
        return {
          feed,
          notes: [
            own
              ? 'Restored from the backup saved in the feed’s Bluesky record. Saving brings it back at the same link.'
              : 'Copied from the settings saved in this feed’s Bluesky record. Publishing creates a new feed on your profile.',
          ],
        }
      }
      if (!value.skyfeedBuilder || typeof value.skyfeedBuilder !== 'object') {
        // One of the member's published feeds whose settings aren't stored anywhere: keep its id, name and description.
        if (did === user && id && !(await isTaken(user, id))) {
          return {
            feed: {
              ...NEW_FEED,
              id,
              displayName: String(value.displayName ?? '').slice(0, 24),
              description: String(value.description ?? '').slice(0, 300) || undefined,
            },
            notes: [
              "This feed's sources and filters aren't stored in Bluesky, so add them again below. Saving keeps its id, so the feed comes back at the same link, with its likes and pins.",
            ],
          }
        }
        throw new Error("That feed doesn't include SkyFeed settings, so there's nothing to import. Recreate it with New feed.")
      }
      builder = value.skyfeedBuilder as SkyfeedBuilder
      record = { displayName: value.displayName as string | undefined, description: value.description as string | undefined }
      ownRkey(uri)
    } else {
      builder = input.builder
      record = input.record
      if (input.uri) {
        ownRkey(input.uri)
      } else {
        // Pasted settings carry no id or description, so look for the member's SkyFeed feed they came from.
        try {
          const theirs = [...(await listGeneratorRecords(await repoAgent(user)))]
          const match = theirs.filter(([, r]) => r.skyfeedBuilder && sameBuilder(builder, r.skyfeedBuilder))
          // A feed already moved here no longer carries SkyFeed's settings, but its name still matches.
          const named = []
          for (const entry of theirs) {
            if (builder.displayName && entry[1].displayName === builder.displayName && !(await isTaken(user, entry[0]))) named.push(entry)
          }
          const [found] = match.length === 1 ? match : named.length === 1 ? named : []
          if (found) {
            rkey = found[0]
            record = { displayName: found[1].displayName, description: found[1].description, ...record }
          }
        } catch (err) {
          console.error('Matching pasted SkyFeed settings to an existing feed failed:', err)
        }
      }
    }

    const { feed, notes } = convertSkyfeed(builder)
    if (record?.displayName) feed.displayName = record.displayName.slice(0, 24)
    if (record?.description) feed.description = record.description.slice(0, 300)
    if (rkey) {
      if (!/^[a-z0-9][a-z0-9-]{0,14}$/.test(rkey) || (await isTaken(user, rkey))) {
        notes.push(`Your existing feed's id "${rkey}" can't be reused here, so this will be published as a new feed.`)
      } else {
        feed.id = rkey
        notes.push('Saving keeps the id of your existing feed. Publishing it afterwards moves that feed here, keeping its link, likes and pins.')
      }
    } else if (foreign) {
      notes.push('This feed belongs to someone else, so publishing creates a new feed on your profile.')
    }
    if (!feed.id && typeof feed.displayName === 'string') feed.id = await freeId(user, slugify(feed.displayName))
    return { feed, notes }
  }

  const showImport = async (c: Context, input: ImportInput, text?: string) => {
    try {
      const { feed, notes } = await importFeed(userIn(c), input)
      return c.html(editorPage({ viewer: me(c), mode: 'new', feed, notes }))
    } catch (err) {
      return c.html(importPage(me(c), { text, error: messageOf(err) }), 400)
    }
  }

  app.get('/feeds/import', requireMember, async (c) => {
    const from = c.req.query('from')
    if (!from) return c.html(importPage(me(c)))
    return showImport(c, { kind: 'link', uri: `at://${userIn(c)}/app.bsky.feed.generator/${from}` })
  })

  app.post('/feeds/import', requireMember, async (c) => {
    const text = String((await c.req.formData()).get('text') ?? '')
    let input: ImportInput
    try {
      input = parseImport(text)
    } catch (err) {
      return c.html(importPage(me(c), { text, error: messageOf(err) }), 400)
    }
    return showImport(c, input, text)
  })

  app.post('/feeds/new', requireMember, async (c) => {
    const user = userIn(c)
    const input = formToDefinition(await c.req.formData())
    // Without JavaScript, or if it was cleared, the id comes from the name.
    if (!input.id && typeof input.displayName === 'string') input.id = slugify(input.displayName) || undefined
    const result = await validate(user, input, true)
    if ('error' in result) return c.html(editorPage({ viewer: me(c), mode: 'new', feed: input, error: result.error }), 400)
    await db.createFeed(user, String(input.id), result.feed)
    registry.invalidate()
    // Recreating a published feed: its record already points here, so back it up straight away.
    await refreshBackup(c, user, String(input.id), result.feed)
    return c.redirect(`/?done=created&feed=${encodeURIComponent(String(input.displayName))}`)
  })

  app.get('/feeds/:id/edit', requireMember, async (c) => {
    const user = userIn(c)
    const id = c.req.param('id')
    if (await registry.isCodeFeed(user, id)) {
      return c.html(errorPage('Defined in code', `"${id}" is defined in feeds/. Edit it there and redeploy.`, me(c)), 400)
    }
    const stored = await db.getFeed(user, id)
    if (!stored) return c.html(errorPage('Not found', `There's no saved feed with id "${id}".`, me(c)), 404)
    return c.html(editorPage({ viewer: me(c), mode: 'edit', feed: { ...(stored.definition as LooseFeed), id } }))
  })

  app.post('/feeds/:id/edit', requireMember, async (c) => {
    const user = userIn(c)
    const id = c.req.param('id')
    if (!(await db.getFeed(user, id))) return c.html(errorPage('Not found', `There's no saved feed with id "${id}".`, me(c)), 404)
    const input: LooseFeed = { ...formToDefinition(await c.req.formData()), id }
    const result = await validate(user, input, false)
    if ('error' in result) return c.html(editorPage({ viewer: me(c), mode: 'edit', feed: input, error: result.error }), 400)
    await db.updateFeed(user, id, result.feed)
    // Saved posts only stay while remember is on, so switching it off doesn't leave them behind.
    if (!result.feed.remember) await db.forgetPosts(feedKey(user, id))
    registry.invalidate()
    await refreshBackup(c, user, id, result.feed)
    return c.redirect(`/?done=saved&feed=${encodeURIComponent(String(input.displayName))}`)
  })

  app.post('/feeds/:id/delete', requireMember, async (c) => {
    const user = userIn(c)
    const id = c.req.param('id')
    if (!(await db.getFeed(user, id))) return c.redirect('/')
    try {
      const agent = await repoAgent(user)
      const record = (await listGeneratorRecords(agent)).get(id)
      // Unpublish first; a published feed with nothing behind it just shows an error in Bluesky.
      if (record?.did === helpers.serviceDidOf(c.req.raw)) await unpublishFeed(agent, id)
    } catch (err) {
      return c.html(errorPage('Delete failed', `Couldn't remove "${id}" from Bluesky, so it wasn't deleted: ${messageOf(err)}`, me(c)), 502)
    }
    await db.deleteFeed(user, id)
    registry.invalidate()
    return c.redirect(`/?done=deleted&feed=${encodeURIComponent(id)}`)
  })

  // --- Publishing ---

  const publishContext = async (c: Context) => {
    const user = userIn(c)
    const id = c.req.param('id')!
    const feed = await engine.feed(user, id)
    const agent = await repoAgent(user)
    const record: GeneratorRecord | undefined = (await listGeneratorRecords(agent)).get(id)
    const status = feed ? publishStatus(feed, record, helpers.serviceDidOf(c.req.raw)) : 'unpublished'
    return { user, id, feed, agent, record, status }
  }

  app.get('/feeds/:id/publish', requireMember, async (c) => {
    try {
      const { feed, record, status, agent } = await publishContext(c)
      if (!feed) return c.html(errorPage('Not found', `There's no feed with id "${c.req.param('id')}".`, me(c)), 404)
      return c.html(
        publishPage(feed, {
          viewer: me(c),
          status,
          hasAvatar: Boolean(record?.avatar),
          avatarUrl: avatarUrl(agent.assertDid, record?.avatar),
          feedLink: feedUrl(agent.assertDid, feed.id),
          blocked: publishBlocked(c.req.raw),
          currentService: status === 'elsewhere' ? record?.did : undefined,
        }),
      )
    } catch (err) {
      return c.html(errorPage('Publish', messageOf(err), me(c)), 502)
    }
  })

  app.post('/feeds/:id/publish', requireMember, async (c) => {
    const form = await c.req.formData()
    let ctx
    try {
      ctx = await publishContext(c)
    } catch (err) {
      return c.html(errorPage('Publish', messageOf(err), me(c)), 502)
    }
    const { user, feed, record, status, agent } = ctx
    if (!feed) return c.html(errorPage('Not found', `There's no feed with id "${ctx.id}".`, me(c)), 404)
    const fail = (error: string) =>
      c.html(
        publishPage(feed, {
          viewer: me(c),
          status,
          hasAvatar: Boolean(record?.avatar),
          avatarUrl: avatarUrl(agent.assertDid, record?.avatar),
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
      const stored = await db.getFeed(user, feed.id)
      await publishFeed(agent, {
        feed,
        serviceDid: helpers.serviceDidOf(c.req.raw),
        previous: record,
        avatar,
        // Feeds made in the editor live only in the database; a copy in the record lets them survive losing it.
        extra: stored ? { [BACKUP_FIELD]: makeBackup(stored.definition) } : undefined,
      })
    } catch (err) {
      return fail(`Publishing failed: ${messageOf(err)}`)
    }
    return c.redirect(`/?done=published&feed=${encodeURIComponent(feed.displayName)}`)
  })

  app.post('/feeds/:id/unpublish', requireMember, async (c) => {
    const id = c.req.param('id')
    try {
      const agent = await repoAgent(userIn(c))
      const record = (await listGeneratorRecords(agent)).get(id)
      // Never delete a record that belongs to some other feed service.
      if (record && record.did !== helpers.serviceDidOf(c.req.raw)) {
        return c.html(errorPage('Unpublish', `"${id}" is served by ${record.did}, not this service, so it was left alone.`, me(c)), 400)
      }
      if (record) await unpublishFeed(agent, id)
    } catch (err) {
      return c.html(errorPage('Unpublish', messageOf(err), me(c)), 502)
    }
    return c.redirect(`/?done=unpublished&feed=${encodeURIComponent(id)}`)
  })
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
