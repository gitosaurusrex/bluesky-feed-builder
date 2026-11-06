import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { LOGIN_COOKIE, Logins, type OwnerAuth, createOwnerAuth } from '../src/auth.js'
import { FeedRestorer, backupOf, makeBackup } from '../src/backup.js'
import { Members } from '../src/members.js'
import type { Bsky } from '../src/bsky.js'
import { loadConfig } from '../src/config.js'
import { parseFeeds } from '../src/feeds/define.js'
import { FeedEngine } from '../src/feeds/engine.js'
import { CombinedRegistry } from '../src/feeds/registry.js'
import { candidate, makePost, memoryDb } from './helpers.js'

const OWNER = 'did:plc:owner'
const HOST = 'feeds.example.com'
const SERVICE = `did:web:${HOST}`
const FRIEND = 'did:plc:friend'
const STRANGER = 'did:plc:stranger'
const HANDLES: Record<string, string> = { 'owner.test': OWNER, 'friend.test': FRIEND, 'stranger.test': STRANGER }

async function setup(env: Record<string, string> = {}) {
  const config = loadConfig({ FEEDGEN_HOSTNAME: HOST, FEEDGEN_PUBLISHER_DID: OWNER, BSKY_IDENTIFIER: 'owner.test', OAUTH_PRIVATE_KEY: '{}', ...env })
  const db = memoryDb()
  // Feeds in feeds/ belong to the admin.
  const registry = new CombinedRegistry(
    parseFeeds([{ id: 'code', displayName: 'Code feed', sources: [{ type: 'likes' }] }]),
    db,
    0,
    undefined,
    async () => OWNER,
  )
  const fetchSource = vi.fn(async (_source: unknown, _opts: { owner?: string }) => [candidate(makePost({ text: 'a post' }))])
  const engine = new FeedEngine(registry, {
    fetchSource,
    resolvePostUri: async (uri) => uri,
    hydratePosts: async () => [],
    cacheSeconds: 60,
    staleSeconds: 600,
  })

  // Stand-ins for each account's Bluesky repo and signed-in session.
  const repos = new Map<string, Map<string, Record<string, unknown>>>()
  const repoOf = (did: string) => repos.get(did) ?? repos.set(did, new Map()).get(did)!
  const makeAgent = (did: string) => {
    const records = repoOf(did)
    return {
    assertDid: did,
    com: {
      atproto: {
        repo: {
          listRecords: async () => ({
            data: { records: [...records].map(([rkey, value]) => ({ uri: `at://${did}/app.bsky.feed.generator/${rkey}`, value })) },
          }),
          getRecord: async ({ rkey }: { rkey: string }) => {
            if (!records.has(rkey)) throw new Error('RecordNotFound')
            return { data: { value: records.get(rkey) } }
          },
          putRecord: vi.fn(async ({ rkey, record }: { rkey: string; record: Record<string, unknown> }) => void records.set(rkey, record)),
          deleteRecord: vi.fn(async ({ rkey }: { rkey: string }) => void records.delete(rkey)),
        },
      },
    },
    uploadBlob: vi.fn(async (bytes: Uint8Array, { encoding }: { encoding: string }) => ({
      data: { blob: { ref: 'blob', mimeType: encoding, size: bytes.length } },
    })),
    }
  }
  const agents = new Map<string, ReturnType<typeof makeAgent>>()
  const agentOf = (did: string) => agents.get(did) ?? agents.set(did, makeAgent(did)).get(did)!
  const agent = agentOf(OWNER)
  const records = repoOf(OWNER)
  const client = {
    authorize: vi.fn(async () => new URL('https://bsky.social/oauth/authorize?request_uri=x')),
    callback: vi.fn(),
    revoke: vi.fn(async () => {}),
    clientMetadata: { client_id: `https://${HOST}/client-metadata.json` },
    jwks: { keys: [] },
  }
  const auth = {
    client,
    local: false,
    confidential: true,
    redirectUri: '',
    repoAgent: async (did: string) => agentOf(did),
    appviewAgent: async (did: string) => agentOf(did),
  }
  const logins = new Logins(db)
  // Feed records in other people's repos, for imports by link.
  const remote = new Map<string, Record<string, unknown>>()
  const bsky = {
    hasAppPassword: false,
    ownerDid: async () => OWNER,
    resolveDid: async (handle: string) => {
      const did = HANDLES[handle.replace(/^@/, '').toLowerCase()] ?? (handle.startsWith('did:') ? handle : undefined)
      if (!did) throw new Error('Unable to resolve handle')
      return did
    },
    toAtUri: async (input: string) => input,
    profileOf: async (did: string) => {
      const handle = Object.keys(HANDLES).find((h) => HANDLES[h] === did)
      return handle ? { handle, avatar: `https://cdn.example/${handle}.jpg` } : undefined
    },
    getRecord: async (uri: string) => {
      const [, did, , rkey] = uri.split('/').slice(1)
      const value = repos.has(did!) ? repos.get(did!)!.get(rkey!) : remote.get(uri)
      if (!value) throw new Error('RecordNotFound')
      return value
    },
  } as unknown as Bsky
  const app = createApp({
    config,
    engine,
    bsky,
    manage: {
      db,
      registry,
      logins,
      auth: async () => auth as unknown as OwnerAuth,
      restorer: new FeedRestorer({ bsky, db, registry }),
      members: new Members(bsky, (env.ALLOWED_ACCOUNTS ?? 'friend.test').split(',').filter(Boolean)),
      databaseId: 'test-db',
      databaseHost: 'test-db.example.turso.io',
    },
  })

  const cookies = new Map<string, string>()
  const cookieFor = async (did: string) => cookies.get(did) ?? cookies.set(did, `${LOGIN_COOKIE}=${await logins.create(did)}`).get(did)!
  const cookie = await cookieFor(OWNER)
  const friendCookie = await cookieFor(FRIEND)
  /** Requests are signed in as the owner, unless `as` names another account or `signedIn` is false. */
  const request = (path: string, init: RequestInit & { signedIn?: boolean; as?: 'friend' } = {}) => {
    const headers = new Headers(init.headers)
    if (init.signedIn !== false) headers.set('cookie', init.as === 'friend' ? friendCookie : cookie)
    if (init.method === 'POST' && !headers.has('origin')) headers.set('origin', `https://${HOST}`)
    return app.request(path, { ...init, headers })
  }
  const post = (path: string, fields: Record<string, string | Blob>, init: RequestInit & { signedIn?: boolean; as?: 'friend' } = {}) => {
    const body = new FormData()
    for (const [k, v] of Object.entries(fields)) body.append(k, v)
    return request(path, { ...init, method: 'POST', body })
  }
  return { app, db, records, remote, agent, client, request, post, engine, repoOf, agentOf, cookieFor, fetchSource }
}

const catFeed = { id: 'cats', displayName: 'Cats', description: 'Cat pictures', 's.0.type': 'search', 's.0.target': 'cats' }

describe('access control', () => {
  it('sends signed-out visitors to the sign-in page', async () => {
    const { request, post } = await setup()
    const page = await request('/feeds/new', { signedIn: false })
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/login')
    expect((await post('/feeds/new', catFeed, { signedIn: false })).status).toBe(401)
  })

  it('shows signed-out visitors only the welcome page, never any feeds', async () => {
    const { request, post, db } = await setup()
    await post('/feeds/new', catFeed)
    expect(await db.getFeed(OWNER, 'cats')).toBeDefined()
    const home = await request('/', { signedIn: false })
    expect(home.status).toBe(200)
    const html = await home.text()
    expect(html).toContain('Sign in with Bluesky')
    expect(html).not.toContain('Code feed')
    expect(html).not.toContain('Cats')
    for (const path of ['/feeds/cats', '/feeds/code']) {
      const res = await request(path, { signedIn: false })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login')
    }
  })

  it('says goodbye after signing out', async () => {
    const { request, post } = await setup()
    const res = await post('/logout', {})
    expect(res.headers.get('location')).toBe('/?done=signed-out')
    expect(await (await request('/?done=signed-out', { signedIn: false })).text()).toContain('You signed out')
  })

  it('shows which account is signed in', async () => {
    const { request } = await setup()
    const owner = await (await request('/')).text()
    expect(owner).toContain('Signed in as')
    expect(owner).toContain('@owner.test')
    expect(owner).toContain('https://cdn.example/owner.test.jpg')
    const friend = await (await request('/feeds/new', { as: 'friend' })).text()
    expect(friend).toContain('@friend.test')
    expect(friend).not.toContain('@owner.test')
  })

  it('still shows the page when the handle can\'t be looked up', async () => {
    const { request, db } = await setup({ ALLOWED_ACCOUNTS: 'did:plc:nohandle' })
    const token = await new Logins(db).create('did:plc:nohandle')
    const res = await request('/', { signedIn: false, headers: { cookie: `${LOGIN_COOKIE}=${token}` } })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Signed in')
  })

  it('rejects form posts from other sites', async () => {
    const { post, db } = await setup()
    const res = await post('/feeds/new', catFeed, { headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    expect(await db.getFeed(OWNER, 'cats')).toBeUndefined()
  })

  it('ignores logins that belong to someone other than the owner', async () => {
    const { request, db } = await setup()
    const token = await new Logins(db).create('did:plc:intruder')
    const res = await request('/feeds/new', { signedIn: false, headers: { cookie: `${LOGIN_COOKIE}=${token}` } })
    expect(res.status).toBe(302)
  })
})

describe('sign-in', () => {
  it('starts OAuth for any invited account, by handle', async () => {
    const { post, client } = await setup()
    for (const handle of ['@Owner.test', 'friend.test']) {
      const res = await post('/login', { handle }, { signedIn: false })
      expect(res.headers.get('location')).toMatch(/^https:\/\/bsky\.social\/oauth\/authorize/)
    }
    expect(client.authorize.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['owner.test', 'friend.test'])
  })

  it('turns away accounts that were not invited before sending them to Bluesky', async () => {
    const { post, client } = await setup()
    const res = await post('/login', { handle: 'stranger.test' }, { signedIn: false })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('ALLOWED_ACCOUNTS')
    expect(client.authorize).not.toHaveBeenCalled()
    expect((await post('/login', { handle: 'nobody.test' }, { signedIn: false })).status).toBe(400)
    expect((await post('/login', { handle: '' }, { signedIn: false })).status).toBe(400)
  })

  it('signs the owner in on callback', async () => {
    const { request, client } = await setup()
    client.callback.mockResolvedValue({ session: { did: OWNER } })
    const res = await request('/oauth/callback?code=x&state=y', { signedIn: false })
    expect(res.headers.get('location')).toBe('/?done=signed-in')
    const setCookie = res.headers.get('set-cookie')!
    expect(setCookie).toContain(`${LOGIN_COOKIE}=`)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
  })

  it('turns away other accounts and revokes their session', async () => {
    const { request, client } = await setup()
    client.callback.mockResolvedValue({ session: { did: 'did:plc:someone' } })
    const res = await request('/oauth/callback?code=x&state=y', { signedIn: false })
    expect(res.status).toBe(403)
    expect(client.revoke).toHaveBeenCalledWith('did:plc:someone')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('signs out', async () => {
    const { request } = await setup()
    await request('/logout', { method: 'POST' })
    expect((await request('/feeds/new')).status).toBe(302)
  })

  it('serves OAuth client metadata', async () => {
    const { request } = await setup()
    expect(await (await request('/client-metadata.json')).json()).toEqual({ client_id: `https://${HOST}/client-metadata.json` })
  })
})

describe('editor', () => {
  it('creates a feed that is served right away', async () => {
    const { post, db, engine, app } = await setup()
    const res = await post('/feeds/new', catFeed)
    expect(res.status).toBe(302)
    expect((await db.getFeed(OWNER, 'cats'))?.definition).toMatchObject({ id: 'cats', sources: [{ type: 'search', query: 'cats' }] })
    expect((await engine.feed(OWNER, 'cats'))?.displayName).toBe('Cats')

    const skeleton = await app.request(
      `/xrpc/app.bsky.feed.getFeedSkeleton?feed=${encodeURIComponent(`at://${OWNER}/app.bsky.feed.generator/cats`)}`,
    )
    expect((await skeleton.json()).feed).toHaveLength(1)
  })

  it('names the id after the feed when it is left empty', async () => {
    const { post, db } = await setup()
    await post('/feeds/new', { ...catFeed, id: '', displayName: 'Café Crème!' })
    expect(await db.getFeed(OWNER, 'cafe-creme')).toBeDefined()
  })

  it('shows validation errors with the entered values', async () => {
    const { post } = await setup()
    const res = await post('/feeds/new', { ...catFeed, 's.0.target': '' })
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('query')
    expect(html).toContain('value="Cats"')
  })

  it('refuses ids that are taken or reserved', async () => {
    const { post } = await setup()
    expect(await (await post('/feeds/new', { ...catFeed, id: 'code' })).text()).toContain('already a feed')
    expect((await post('/feeds/new', { ...catFeed, id: 'new' })).status).toBe(400)
    await post('/feeds/new', catFeed)
    expect((await post('/feeds/new', catFeed)).status).toBe(400)
  })

  it('edits a feed without letting its id change', async () => {
    const { post, db, engine } = await setup()
    await post('/feeds/new', catFeed)
    await post('/feeds/cats/edit', { ...catFeed, id: 'other', displayName: 'Kitties' })
    expect((await db.getFeed(OWNER, 'cats'))?.definition).toMatchObject({ id: 'cats', displayName: 'Kitties' })
    expect(await db.getFeed(OWNER, 'other')).toBeUndefined()
    expect((await engine.feed(OWNER, 'cats'))?.displayName).toBe('Kitties')
  })

  it('forgets remembered posts when remember is switched off', async () => {
    const { post, db } = await setup()
    await post('/feeds/new', { ...catFeed, remember: 'on' })
    expect((await db.getFeed(OWNER, 'cats'))?.definition).toMatchObject({ remember: true })
    await db.rememberPosts(`${OWNER}/cats`, [candidate(makePost())], 10)
    await post('/feeds/cats/edit', { ...catFeed, remember: 'on' })
    expect(await db.rememberedPosts(`${OWNER}/cats`)).toHaveLength(1)
    await post('/feeds/cats/edit', catFeed)
    expect(await db.rememberedPosts(`${OWNER}/cats`)).toEqual([])
  })

  it("doesn't edit feeds defined in code", async () => {
    const { request } = await setup()
    expect(await (await request('/feeds/code/edit')).text()).toContain('defined in feeds/')
  })

  it('deletes a feed and removes it from Bluesky', async () => {
    const { post, db, records, agent } = await setup()
    await post('/feeds/new', catFeed)
    await post('/feeds/cats/publish', {})
    await post('/feeds/cats/delete', {})
    expect(agent.com.atproto.repo.deleteRecord).toHaveBeenCalled()
    expect(records.has('cats')).toBe(false)
    expect(await db.getFeed(OWNER, 'cats')).toBeUndefined()
  })
})

describe('publishing', () => {
  it('publishes a feed record pointing at this service', async () => {
    const { post, records, request } = await setup()
    await post('/feeds/new', catFeed)
    expect(await (await request('/')).text()).toContain('Not published')

    const res = await post('/feeds/cats/publish', {})
    expect(res.headers.get('location')).toBe('/?done=published&feed=Cats')
    expect(records.get('cats')).toMatchObject({ $type: 'app.bsky.feed.generator', did: SERVICE, displayName: 'Cats', description: 'Cat pictures' })
    expect(await (await request('/')).text()).toContain('Live in Bluesky')
  })

  it('publishes code feeds too', async () => {
    const { post, records } = await setup()
    await post('/feeds/code/publish', {})
    expect(records.get('code')).toMatchObject({ did: SERVICE, displayName: 'Code feed' })
  })

  it('flags feeds whose name changed since publishing, and keeps createdAt on update', async () => {
    const { post, records, request } = await setup()
    await post('/feeds/new', catFeed)
    await post('/feeds/cats/publish', {})
    const createdAt = records.get('cats')!.createdAt
    await post('/feeds/cats/edit', { ...catFeed, displayName: 'Kitties' })
    expect(await (await request('/')).text()).toContain('Name or description changed')
    await post('/feeds/cats/publish', {})
    expect(records.get('cats')).toMatchObject({ displayName: 'Kitties', createdAt })
  })

  it('uploads, keeps and removes avatars', async () => {
    const { post, records, agent } = await setup()
    await post('/feeds/new', catFeed)
    await post('/feeds/cats/publish', { avatar: new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }) })
    expect(agent.uploadBlob).toHaveBeenCalledTimes(1)
    expect(records.get('cats')!.avatar).toMatchObject({ mimeType: 'image/png', size: 3 })

    await post('/feeds/cats/publish', {})
    expect(records.get('cats')!.avatar).toBeDefined()

    await post('/feeds/cats/publish', { removeAvatar: 'on' })
    expect(records.get('cats')!.avatar).toBeUndefined()
  })

  it("previews the current avatar from Bluesky's CDN", async () => {
    const { post, request, records } = await setup()
    await post('/feeds/new', catFeed)
    expect(await (await request('/feeds/cats/publish')).text()).toContain('No avatar yet')
    records.set('cats', { did: SERVICE, displayName: 'Cats', createdAt: '', avatar: { ref: { $link: 'bafkreiabc123' }, mimeType: 'image/png', size: 3 } })
    const html = await (await request('/feeds/cats/publish')).text()
    expect(html).toContain(`src="https://cdn.bsky.app/img/avatar/plain/${OWNER}/bafkreiabc123"`)
    expect(html).toContain('Remove the current avatar')
  })

  it('rejects avatars that are not PNG or JPEG', async () => {
    const { post, agent } = await setup()
    await post('/feeds/new', catFeed)
    const res = await post('/feeds/cats/publish', { avatar: new File(['gif'], 'a.gif', { type: 'image/gif' }) })
    expect(res.status).toBe(400)
    expect(agent.uploadBlob).not.toHaveBeenCalled()
  })

  it("won't unpublish a feed that belongs to another service", async () => {
    const { request, records, agent } = await setup()
    records.set('theirs', { did: 'did:web:other.example', displayName: 'Theirs', createdAt: '' })
    const res = await request('/feeds/theirs/unpublish', { method: 'POST' })
    expect(res.status).toBe(400)
    expect(agent.com.atproto.repo.deleteRecord).not.toHaveBeenCalled()
  })

  it('lists published feeds that no longer exist so they can be removed', async () => {
    const { request, records } = await setup()
    records.set('gone', { did: SERVICE, displayName: 'Gone', createdAt: '' })
    records.set('theirs', { did: 'did:web:other.example', displayName: 'Theirs', createdAt: '' })
    const html = await (await request('/')).text()
    expect(html).toContain('Published but missing')
    expect(html).toContain('/feeds/gone/unpublish')
    expect(html).not.toContain('/feeds/theirs/unpublish')
  })

  it('refuses to publish from a local server', async () => {
    const { post, records } = await setup({ FEEDGEN_HOSTNAME: '127.0.0.1:3000' })
    await post('/feeds/new', catFeed, { headers: { origin: 'http://127.0.0.1:3000' } })
    const res = await post('/feeds/cats/publish', {}, { headers: { origin: 'http://127.0.0.1:3000' } })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('published from a local server')
    expect(records.size).toBe(0)
  })
})

describe('createOwnerAuth', () => {
  it('describes a confidential client when there is a private key', async () => {
    const { generateOAuthKey } = await import('../src/auth.js')
    const config = loadConfig({ FEEDGEN_HOSTNAME: HOST, OAUTH_PRIVATE_KEY: await generateOAuthKey() })
    const auth = await createOwnerAuth(config, memoryDb())
    expect(auth.confidential).toBe(true)
    expect(auth.client.clientMetadata).toMatchObject({
      client_id: `https://${HOST}/client-metadata.json`,
      redirect_uris: [`https://${HOST}/oauth/callback`],
      token_endpoint_auth_method: 'private_key_jwt',
      jwks_uri: `https://${HOST}/oauth/jwks.json`,
    })
    expect(auth.client.clientMetadata.scope).toContain('repo:app.bsky.feed.generator')
    // Only the public half is published (checked as served, i.e. after JSON encoding).
    const [key] = JSON.parse(JSON.stringify(auth.client.jwks)).keys
    expect(key).toHaveProperty('x')
    expect(key).not.toHaveProperty('d')
  })

  it('generates a key once and keeps it when none is configured', async () => {
    const db = memoryDb()
    const first = await createOwnerAuth(loadConfig({ FEEDGEN_HOSTNAME: HOST }), db)
    const second = await createOwnerAuth(loadConfig({ FEEDGEN_HOSTNAME: HOST }), db)
    expect(first.confidential).toBe(true)
    expect(first.client.clientMetadata.token_endpoint_auth_method).toBe('private_key_jwt')
    const kid = (auth: typeof first) => JSON.parse(JSON.stringify(auth.client.jwks)).keys[0].kid
    expect(kid(second)).toBe(kid(first))
  })

  it('prefers OAUTH_PRIVATE_KEY over a stored key', async () => {
    const { generateOAuthKey } = await import('../src/auth.js')
    const db = memoryDb()
    await createOwnerAuth(loadConfig({ FEEDGEN_HOSTNAME: HOST }), db)
    const key = await generateOAuthKey()
    const auth = await createOwnerAuth(loadConfig({ FEEDGEN_HOSTNAME: HOST, OAUTH_PRIVATE_KEY: key }), db)
    expect(JSON.parse(JSON.stringify(auth.client.jwks)).keys[0].kid).toBe(JSON.parse(key).kid)
  })

  it("uses Bluesky's development client on localhost", async () => {
    const auth = await createOwnerAuth(loadConfig({ PORT: '4000' }), memoryDb())
    expect(auth.local).toBe(true)
    expect(auth.redirectUri).toBe('http://127.0.0.1:4000/oauth/callback')
    expect(auth.client.clientMetadata.client_id).toMatch(/^http:\/\/localhost\?/)
  })
})

// The real settings of a SkyFeed feed, as SkyFeed stores them in the feed record.
const SKYFEED = {
  blocks: [
    { id: 'a1', did: OWNER, type: 'input', inputType: 'did' },
    { id: 'a2', type: 'regex', value: '💿 #', target: 'text', caseSensitive: false },
    { id: 'a3', type: 'remember' },
    { id: 'a4', type: 'sort', sortType: 'created_at' },
  ],
  license: 'MIT',
  displayName: 'Aural Vibes',
}
const skyfeedRecord = () => ({
  $type: 'app.bsky.feed.generator',
  did: 'did:web:skyfeed.me',
  displayName: 'Aural Vibes',
  description: 'What I am listening to',
  avatar: { ref: 'skyfeed-avatar', mimeType: 'image/png', size: 9 },
  createdAt: '2026-01-01T00:00:00.000Z',
  skyfeedBuilder: SKYFEED,
})

describe('importing from SkyFeed', () => {
  it('offers feeds hosted elsewhere for import', async () => {
    const { request, records } = await setup()
    records.set('aaapg3h5l6lh4', skyfeedRecord())
    const html = await (await request('/')).text()
    expect(html).toContain('On other services')
    expect(html).toContain('SkyFeed')
    expect(html).toContain('/feeds/import?from=aaapg3h5l6lh4')
  })

  it("converts the owner's feed and keeps its id", async () => {
    const { request, records } = await setup()
    records.set('aaapg3h5l6lh4', skyfeedRecord())
    const html = await (await request('/feeds/import?from=aaapg3h5l6lh4')).text()
    expect(html).toContain('value="aaapg3h5l6lh4"')
    expect(html).toContain('value="Aural Vibes"')
    expect(html).toContain('💿 #')
    expect(html).toContain('remember')
    expect(html).toContain('moves that feed here')
  })

  it("matches pasted JSON to the owner's SkyFeed feed, so the id and description come along", async () => {
    const { post, records } = await setup()
    records.set('aaapg3h5l6lh4', skyfeedRecord())
    const uri = `at://${OWNER}/app.bsky.feed.generator/aaapg3h5l6lh4`
    // SkyFeed's settings on their own (keys reordered, as a copy might be), the whole record, and a getRecord response.
    const reordered = { displayName: SKYFEED.displayName, blocks: SKYFEED.blocks.map((b) => Object.fromEntries(Object.entries(b).reverse())) }
    for (const json of [SKYFEED, reordered, skyfeedRecord(), { uri, value: skyfeedRecord() }]) {
      const html = await (await post('/feeds/import', { text: JSON.stringify(json) })).text()
      expect(html).toContain('value="aaapg3h5l6lh4"')
      expect(html).toContain('value="Aural Vibes"')
      expect(html).toContain('What I am listening to')
      expect(html).toContain('💿 #')
    }
  })

  it("names the id after the feed when pasted JSON doesn't match an existing feed", async () => {
    const { post, db } = await setup()
    expect(await (await post('/feeds/import', { text: JSON.stringify(SKYFEED) })).text()).toContain('value="aural-vibes"')
    await db.createFeed(OWNER, 'aural-vibes', {})
    expect(await (await post('/feeds/import', { text: JSON.stringify(SKYFEED) })).text()).toContain('value="aural-vibes-2"')
  })

  it('recreates a published feed whose settings were lost, keeping its id', async () => {
    const { request, records, post, db } = await setup()
    // Moved here earlier, so SkyFeed's settings are gone from the record, and the saved feed is missing.
    records.set('aaapg3h5l6lh4', { did: SERVICE, displayName: 'Aural Vibes', description: 'What I am listening to', createdAt: '' })
    const dashboard = await (await request('/')).text()
    expect(dashboard).toContain('Published but missing')
    expect(dashboard).toContain('/feeds/import?from=aaapg3h5l6lh4')

    const editor = await (await request('/feeds/import?from=aaapg3h5l6lh4')).text()
    expect(editor).toContain('value="aaapg3h5l6lh4"')
    expect(editor).toContain('value="Aural Vibes"')
    expect(editor).toContain('add them again')

    // Pasting the SkyFeed settings instead fills in the sources too, and still finds the id by name.
    const pasted = await (await post('/feeds/import', { text: JSON.stringify(SKYFEED) })).text()
    expect(pasted).toContain('value="aaapg3h5l6lh4"')
    expect(pasted).toContain('What I am listening to')
    expect(pasted).toContain('💿 #')

    await post('/feeds/new', { id: 'aaapg3h5l6lh4', displayName: 'Aural Vibes', 's.0.type': 'author', 's.0.target': OWNER })
    expect(await db.getFeed(OWNER, 'aaapg3h5l6lh4')).toBeDefined()
    expect(await (await request('/')).text()).not.toContain('Published but missing')
  })

  it("gives someone else's feed a new id", async () => {
    const { post, remote } = await setup()
    const uri = 'at://did:plc:someone/app.bsky.feed.generator/theirfeed'
    remote.set(uri, { ...skyfeedRecord(), displayName: 'Their feed' })
    const html = await (await post('/feeds/import', { text: uri })).text()
    expect(html).toContain('value="Their feed"')
    expect(html).not.toContain('value="theirfeed"')
    expect(html).toContain('belongs to someone else')
  })

  it('explains bad input', async () => {
    const { post } = await setup()
    expect(await (await post('/feeds/import', { text: 'not json' })).text()).toContain("isn&#39;t a feed link or valid JSON")
  })

  it('moves the feed here only after confirmation, keeping its avatar, date and SkyFeed settings', async () => {
    const { post, records, request } = await setup()
    records.set('aaapg3h5l6lh4', skyfeedRecord())
    // Save the imported feed as the editor would submit it.
    await post('/feeds/new', {
      id: 'aaapg3h5l6lh4',
      displayName: 'Aural Vibes',
      description: 'What I am listening to',
      's.0.type': 'author',
      's.0.target': OWNER,
      'f.includeRegex': '💿 #',
    })
    const dashboard = await (await request('/')).text()
    expect(dashboard).toContain('Move to Blue Feeds')
    expect(dashboard).not.toContain('On other services')

    const refused = await post('/feeds/aaapg3h5l6lh4/publish', {})
    expect(refused.status).toBe(400)
    expect(records.get('aaapg3h5l6lh4')!.did).toBe('did:web:skyfeed.me')

    await post('/feeds/aaapg3h5l6lh4/publish', { takeover: 'on' })
    expect(records.get('aaapg3h5l6lh4')).toMatchObject({
      did: SERVICE,
      displayName: 'Aural Vibes',
      avatar: { ref: 'skyfeed-avatar' },
      createdAt: '2026-01-01T00:00:00.000Z',
      skyfeedBuilder: SKYFEED,
    })
    expect(await (await request('/')).text()).toContain('Live in Bluesky')
  })
})

describe('backups in the feed record', () => {
  const skeleton = (id: string) =>
    `/xrpc/app.bsky.feed.getFeedSkeleton?feed=${encodeURIComponent(`at://${OWNER}/app.bsky.feed.generator/${id}`)}`

  it("stores editor feeds' settings in the record when publishing, but not code feeds'", async () => {
    const { post, records } = await setup()
    await post('/feeds/new', catFeed)
    await post('/feeds/cats/publish', {})
    expect(backupOf(records.get('cats'))).toMatchObject({ id: 'cats', sources: [{ type: 'search', query: 'cats' }] })
    await post('/feeds/code/publish', {})
    expect(records.get('code')!.blueFeeds).toBeUndefined()
  })

  it('stores decimal settings, which Bluesky records only accept as text', async () => {
    const { post, records } = await setup()
    await post('/feeds/new', { ...catFeed, 'f.maxAgeHours': '1.5' })
    await post('/feeds/cats/publish', {})
    const stored = records.get('cats')!.blueFeeds as Record<string, unknown>
    expect(typeof stored.definition).toBe('string')
    // Every number left in the record is a whole number.
    const numbers = (v: unknown): number[] =>
      typeof v === 'number' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(numbers) : []
    expect(numbers(records.get('cats')).every(Number.isInteger)).toBe(true)
    expect(backupOf(records.get('cats'))).toMatchObject({ filters: { maxAgeHours: 1.5 } })
  })

  it('keeps the backup current when a published feed is edited, without touching the rest of the record', async () => {
    const { post, records } = await setup()
    await post('/feeds/new', catFeed)
    await post('/feeds/cats/publish', {})
    const createdAt = records.get('cats')!.createdAt
    await post('/feeds/cats/edit', { ...catFeed, 's.0.target': 'kittens' })
    expect(records.get('cats')!.createdAt).toBe(createdAt)
    expect(backupOf(records.get('cats'))).toMatchObject({ sources: [{ query: 'kittens' }] })
  })

  it('heals itself when Bluesky asks for a feed the database lost', async () => {
    const { post, records, app, db } = await setup()
    await post('/feeds/new', catFeed)
    await post('/feeds/cats/publish', {})
    await db.deleteFeed(OWNER, 'cats') // the database is swapped or emptied
    const res = await app.request(skeleton('cats'))
    expect(res.status).toBe(200)
    expect((await res.json()).feed).toHaveLength(1)
    expect((await db.getFeed(OWNER, 'cats'))?.definition).toMatchObject({ sources: [{ query: 'cats' }] })
    expect(records.get('cats')!.did).toBe(SERVICE)
  })

  it("doesn't restore feeds without a backup, or served by another service", async () => {
    const { app, records, db } = await setup()
    records.set('plain', { did: SERVICE, displayName: 'Plain', createdAt: '' })
    records.set('theirs', { did: 'did:web:other.example', displayName: 'Theirs', createdAt: '', blueFeeds: makeBackup({ displayName: 'Theirs', sources: [{ type: 'likes' }] }) })
    expect((await app.request(skeleton('plain'))).status).toBe(400)
    expect((await app.request(skeleton('theirs'))).status).toBe(400)
    expect(await db.getFeed(OWNER, 'plain')).toBeUndefined()
    expect(await db.getFeed(OWNER, 'theirs')).toBeUndefined()
  })

  it('restores missing feeds when the dashboard loads', async () => {
    const { request, records, db } = await setup()
    records.set('aaapg3h5l6lh4', {
      did: SERVICE,
      displayName: 'Aural Vibes',
      createdAt: '',
      blueFeeds: makeBackup({ id: 'aaapg3h5l6lh4', displayName: 'Aural Vibes', sources: [{ type: 'author', actors: [OWNER] }], filters: { includeRegex: '💿 #' } }),
    })
    const html = await (await request('/')).text()
    expect(html).toContain('Restored Aural Vibes from the backup in Bluesky.')
    expect(html).not.toContain('Published but missing')
    expect(await db.getFeed(OWNER, 'aaapg3h5l6lh4')).toBeDefined()
  })

  it('fills the editor from the backup when recreating', async () => {
    const { request, records } = await setup()
    records.set('gone', {
      did: SERVICE,
      displayName: 'Gone',
      createdAt: '',
      // A broken backup isn't restored automatically, but Recreate can still start from it.
      blueFeeds: makeBackup({ id: 'gone', displayName: 'Gone', maxPosts: -1, sources: [{ type: 'search', query: 'backed up' }] }),
    })
    const html = await (await request('/feeds/import?from=gone')).text()
    expect(html).toContain('value="gone"')
    expect(html).toContain('backed up')
    expect(html).toContain('Restored from the backup')
  })

  it('shows the owner, and only the owner, where the database lives', async () => {
    const { request } = await setup()
    expect(await (await request('/')).text()).toContain('test-db.example.turso.io')
    expect(await (await request('/', { signedIn: false })).text()).not.toContain('test-db.example.turso.io')
  })

  it('reports a stable fingerprint of the database', async () => {
    const { app } = await setup()
    const first = await (await app.request('/health')).json()
    const second = await (await app.request('/health')).json()
    expect(first.database).toMatchObject({ id: 'test-db', createdAt: expect.any(String) })
    expect(second.database).toEqual(first.database)
  })
})

describe('FeedRestorer', () => {
  it('asks Bluesky about an unrestorable feed at most once every few minutes', async () => {
    let now = 0
    const getRecord = vi.fn(async () => ({ did: SERVICE, displayName: 'No backup' }))
    const db = memoryDb()
    const registry = new CombinedRegistry([], db, 0)
    const restorer = new FeedRestorer({ bsky: { getRecord } as unknown as Bsky, db, registry }, () => now)
    expect(await restorer.restore(OWNER, 'x', SERVICE)).toBe(false)
    expect(await restorer.restore(OWNER, 'x', SERVICE)).toBe(false)
    expect(getRecord).toHaveBeenCalledTimes(1)
    now = 5 * 60_000
    await restorer.restore(OWNER, 'x', SERVICE)
    expect(getRecord).toHaveBeenCalledTimes(2)
  })
})

describe('invited accounts', () => {
  const skeleton = (did: string, id: string) =>
    `/xrpc/app.bsky.feed.getFeedSkeleton?feed=${encodeURIComponent(`at://${did}/app.bsky.feed.generator/${id}`)}`

  it('signs in invited accounts and turns everyone else away', async () => {
    const { request, client } = await setup()
    client.callback.mockResolvedValueOnce({ session: { did: FRIEND } })
    expect((await request('/oauth/callback?code=x&state=y', { signedIn: false })).headers.get('location')).toBe('/?done=signed-in')
    client.callback.mockResolvedValueOnce({ session: { did: STRANGER } })
    const refused = await request('/oauth/callback?code=x&state=y', { signedIn: false })
    expect(refused.status).toBe(403)
    expect(client.revoke).toHaveBeenCalledWith(STRANGER)
  })

  it('keeps each account to its own feeds, even with the same id', async () => {
    const { post, request, db } = await setup()
    await post('/feeds/new', catFeed)
    await post('/feeds/new', { ...catFeed, displayName: 'Friend cats', description: 'Tabbies only', 's.0.target': 'tabby' }, { as: 'friend' })
    expect((await db.getFeed(OWNER, 'cats'))?.definition).toMatchObject({ displayName: 'Cats' })
    expect((await db.getFeed(FRIEND, 'cats'))?.definition).toMatchObject({ displayName: 'Friend cats' })

    const ownerView = await (await request('/')).text()
    const friendView = await (await request('/', { as: 'friend' })).text()
    expect(ownerView).toContain('Cat pictures')
    expect(ownerView).toContain('Code feed')
    expect(ownerView).not.toContain('Tabbies only')
    expect(friendView).toContain('Tabbies only')
    expect(friendView).not.toContain('Cat pictures')
    expect(friendView).not.toContain('Code feed') // feeds in feeds/ are the admin's

    // Editing and deleting only ever touch the signed-in account's feed.
    await post('/feeds/cats/edit', { ...catFeed, displayName: 'Changed' }, { as: 'friend' })
    expect((await db.getFeed(OWNER, 'cats'))?.definition).toMatchObject({ displayName: 'Cats' })
    await post('/feeds/cats/delete', {}, { as: 'friend' })
    expect(await db.getFeed(FRIEND, 'cats')).toBeUndefined()
    expect(await db.getFeed(OWNER, 'cats')).toBeDefined()
  })

  it("publishes to the member's own account and serves it to Bluesky", async () => {
    const { post, app, repoOf, records } = await setup()
    await post('/feeds/new', { ...catFeed, displayName: 'Friend cats' }, { as: 'friend' })
    await post('/feeds/cats/publish', {}, { as: 'friend' })
    expect(repoOf(FRIEND).get('cats')).toMatchObject({ did: SERVICE, displayName: 'Friend cats' })
    expect(backupOf(repoOf(FRIEND).get('cats'))).toMatchObject({ displayName: 'Friend cats' })
    expect(records.has('cats')).toBe(false) // nothing written to the owner's account

    const res = await app.request(skeleton(FRIEND, 'cats'))
    expect(res.status).toBe(200)
    const described = await (await app.request('/xrpc/app.bsky.feed.describeFeedGenerator')).json()
    expect(described.feeds).toContainEqual({ uri: `at://${FRIEND}/app.bsky.feed.generator/cats` })
  })

  it("runs each feed's searches with its own account's session", async () => {
    const { post, app, fetchSource } = await setup()
    await post('/feeds/new', catFeed, { as: 'friend' })
    await app.request(skeleton(FRIEND, 'cats'))
    expect(fetchSource.mock.calls.at(-1)![1]).toMatchObject({ owner: FRIEND })
  })

  it("doesn't serve or restore feeds of accounts that aren't members", async () => {
    const { app, repoOf, db } = await setup()
    repoOf(STRANGER).set('cats', { did: SERVICE, displayName: 'Theirs', createdAt: '', blueFeeds: makeBackup({ displayName: 'Theirs', sources: [{ type: 'likes' }] }) })
    expect((await app.request(skeleton(STRANGER, 'cats'))).status).toBe(400)
    expect(await db.getFeed(STRANGER, 'cats')).toBeUndefined()
  })

  it('signs out and stops serving an account removed from ALLOWED_ACCOUNTS', async () => {
    const before = await setup()
    await before.post('/feeds/new', catFeed, { as: 'friend' })
    expect((await before.app.request(skeleton(FRIEND, 'cats'))).status).toBe(200)

    const after = await setup({ ALLOWED_ACCOUNTS: '' })
    await after.db.createFeed(FRIEND, 'cats', { id: 'cats', displayName: 'Cats', sources: [{ type: 'likes' }] })
    expect((await after.request('/feeds/new', { as: 'friend' })).headers.get('location')).toBe('/login')
    expect((await after.app.request(skeleton(FRIEND, 'cats'))).status).toBe(400)
  })

  it('lets a member reuse an id the admin uses for a feed in code', async () => {
    const { post, db } = await setup()
    await post('/feeds/new', { ...catFeed, id: 'code' }, { as: 'friend' })
    expect(await db.getFeed(FRIEND, 'code')).toBeDefined()
    expect((await post('/feeds/new', { ...catFeed, id: 'code' })).status).toBe(400)
  })
})

describe('Members', () => {
  it('is the admin plus every invited account that resolves', async () => {
    const bsky = {
      ownerDid: async () => OWNER,
      resolveDid: async (a: string) => (a === 'gone.test' ? Promise.reject(new Error('not found')) : HANDLES[a] ?? a),
    } as unknown as Bsky
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const members = new Members(bsky, ['friend.test', 'gone.test', 'did:plc:direct'])
    expect([...(await members.dids())].sort()).toEqual(['did:plc:direct', FRIEND, OWNER].sort())
    expect(await members.has(STRANGER)).toBe(false)
    expect(await members.has(undefined)).toBe(false)
  })
})
