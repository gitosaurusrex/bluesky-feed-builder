import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { LOGIN_COOKIE, Logins, type OwnerAuth, createOwnerAuth } from '../src/auth.js'
import type { Bsky } from '../src/bsky.js'
import { loadConfig } from '../src/config.js'
import { parseFeeds } from '../src/feeds/define.js'
import { FeedEngine } from '../src/feeds/engine.js'
import { CombinedRegistry } from '../src/feeds/registry.js'
import { candidate, makePost, memoryDb } from './helpers.js'

const OWNER = 'did:plc:owner'
const HOST = 'feeds.example.com'
const SERVICE = `did:web:${HOST}`

async function setup(env: Record<string, string> = {}) {
  const config = loadConfig({ FEEDGEN_HOSTNAME: HOST, FEEDGEN_PUBLISHER_DID: OWNER, BSKY_IDENTIFIER: 'owner.test', OAUTH_PRIVATE_KEY: '{}', ...env })
  const db = memoryDb()
  const registry = new CombinedRegistry(parseFeeds([{ id: 'code', displayName: 'Code feed', sources: [{ type: 'likes' }] }]), db, 0)
  const engine = new FeedEngine(registry, {
    fetchSource: async () => [candidate(makePost({ text: 'a post' }))],
    resolvePostUri: async (uri) => uri,
    hydratePosts: async () => [],
    cacheSeconds: 60,
    staleSeconds: 600,
  })

  // A stand-in for the owner's Bluesky repo.
  const records = new Map<string, Record<string, unknown>>()
  const agent = {
    assertDid: OWNER,
    com: {
      atproto: {
        repo: {
          listRecords: async () => ({
            data: { records: [...records].map(([rkey, value]) => ({ uri: `at://${OWNER}/app.bsky.feed.generator/${rkey}`, value })) },
          }),
          putRecord: vi.fn(async ({ rkey, record }: { rkey: string; record: Record<string, unknown> }) => void records.set(rkey, record)),
          deleteRecord: vi.fn(async ({ rkey }: { rkey: string }) => void records.delete(rkey)),
        },
      },
    },
    uploadBlob: vi.fn(async (bytes: Uint8Array, { encoding }: { encoding: string }) => ({
      data: { blob: { ref: 'blob', mimeType: encoding, size: bytes.length } },
    })),
  }
  const client = {
    authorize: vi.fn(async () => new URL('https://bsky.social/oauth/authorize?request_uri=x')),
    callback: vi.fn(),
    revoke: vi.fn(async () => {}),
    clientMetadata: { client_id: `https://${HOST}/client-metadata.json` },
    jwks: { keys: [] },
  }
  const auth = { client, local: false, confidential: true, redirectUri: '', repoAgent: async () => agent, appviewAgent: async () => agent }
  const logins = new Logins(db)
  // Feed records in other people's repos, for imports by link.
  const remote = new Map<string, Record<string, unknown>>()
  const bsky = {
    hasAppPassword: false,
    ownerDid: async () => OWNER,
    toAtUri: async (input: string) => input,
    getRecord: async (uri: string) => {
      const [, did, , rkey] = uri.split('/').slice(1)
      const value = did === OWNER ? records.get(rkey!) : remote.get(uri)
      if (!value) throw new Error('RecordNotFound')
      return value
    },
  } as unknown as Bsky
  const app = createApp({
    config,
    engine,
    bsky,
    manage: { db, registry, logins, auth: async () => auth as unknown as OwnerAuth },
  })

  const cookie = `${LOGIN_COOKIE}=${await logins.create(OWNER)}`
  const request = (path: string, init: RequestInit & { signedIn?: boolean } = {}) => {
    const headers = new Headers(init.headers)
    if (init.signedIn !== false) headers.set('cookie', cookie)
    if (init.method === 'POST' && !headers.has('origin')) headers.set('origin', `https://${HOST}`)
    return app.request(path, { ...init, headers })
  }
  const post = (path: string, fields: Record<string, string | Blob>, init: RequestInit & { signedIn?: boolean } = {}) => {
    const body = new FormData()
    for (const [k, v] of Object.entries(fields)) body.append(k, v)
    return request(path, { ...init, method: 'POST', body })
  }
  return { app, db, records, remote, agent, client, request, post, engine }
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

  it('rejects form posts from other sites', async () => {
    const { post, db } = await setup()
    const res = await post('/feeds/new', catFeed, { headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    expect(await db.getFeed('cats')).toBeUndefined()
  })

  it('ignores logins that belong to someone other than the owner', async () => {
    const { request, db } = await setup()
    const token = await new Logins(db).create('did:plc:intruder')
    const res = await request('/feeds/new', { signedIn: false, headers: { cookie: `${LOGIN_COOKIE}=${token}` } })
    expect(res.status).toBe(302)
  })
})

describe('sign-in', () => {
  it('starts OAuth for the owner', async () => {
    const { post, client } = await setup()
    const res = await post('/login', {}, { signedIn: false })
    expect(client.authorize).toHaveBeenCalledWith(OWNER)
    expect(res.headers.get('location')).toMatch(/^https:\/\/bsky\.social\/oauth\/authorize/)
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
    expect((await db.getFeed('cats'))?.definition).toMatchObject({ id: 'cats', sources: [{ type: 'search', query: 'cats' }] })
    expect((await engine.feed('cats'))?.displayName).toBe('Cats')

    const skeleton = await app.request(
      `/xrpc/app.bsky.feed.getFeedSkeleton?feed=${encodeURIComponent(`at://${OWNER}/app.bsky.feed.generator/cats`)}`,
    )
    expect((await skeleton.json()).feed).toHaveLength(1)
  })

  it('names the id after the feed when it is left empty', async () => {
    const { post, db } = await setup()
    await post('/feeds/new', { ...catFeed, id: '', displayName: 'Café Crème!' })
    expect(await db.getFeed('cafe-creme')).toBeDefined()
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
    expect((await db.getFeed('cats'))?.definition).toMatchObject({ id: 'cats', displayName: 'Kitties' })
    expect(await db.getFeed('other')).toBeUndefined()
    expect((await engine.feed('cats'))?.displayName).toBe('Kitties')
  })

  it('forgets remembered posts when remember is switched off', async () => {
    const { post, db } = await setup()
    await post('/feeds/new', { ...catFeed, remember: 'on' })
    expect((await db.getFeed('cats'))?.definition).toMatchObject({ remember: true })
    await db.rememberPosts('cats', [candidate(makePost())], 10)
    await post('/feeds/cats/edit', { ...catFeed, remember: 'on' })
    expect(await db.rememberedPosts('cats')).toHaveLength(1)
    await post('/feeds/cats/edit', catFeed)
    expect(await db.rememberedPosts('cats')).toEqual([])
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
    expect(await db.getFeed('cats')).toBeUndefined()
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
    expect(html).toContain('Your feeds on other services')
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
    await db.createFeed('aural-vibes', {})
    expect(await (await post('/feeds/import', { text: JSON.stringify(SKYFEED) })).text()).toContain('value="aural-vibes-2"')
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
    expect(dashboard).toContain('Move to Feed Builder')
    expect(dashboard).not.toContain('Your feeds on other services')

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
