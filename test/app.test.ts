import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import type { Bsky } from '../src/bsky.js'
import { loadConfig } from '../src/config.js'
import { parseFeeds } from '../src/feeds/define.js'
import { FeedEngine } from '../src/feeds/engine.js'
import { StaticRegistry } from '../src/feeds/registry.js'
import { candidate, makePost } from './helpers.js'

const PUBLISHER = 'did:plc:publisher'

function setup(env: Record<string, string> = {}, published: { rkey: string; did: string; displayName: string }[] = []) {
  const config = loadConfig({ FEEDGEN_HOSTNAME: 'feeds.example.com', FEEDGEN_PUBLISHER_DID: PUBLISHER, ADMIN_TOKEN: 'secret', ...env })
  const posts = [candidate(makePost({ text: 'hello' }))]
  const engine = new FeedEngine(new StaticRegistry(parseFeeds([{ id: 'hello', displayName: 'Hello', sources: [{ type: 'likes' }] }])), {
    fetchSource: vi.fn(async () => posts),
    resolvePostUri: async (uri) => uri,
    hydratePosts: async () => [],
    cacheSeconds: 60,
    staleSeconds: 600,
  })
  // What Bluesky's public AppView reports as published by the owner.
  const getActorFeeds = async () => ({
    data: { feeds: published.map((f) => ({ uri: `at://${PUBLISHER}/app.bsky.feed.generator/${f.rkey}`, did: f.did, displayName: f.displayName, indexedAt: '' })) },
  })
  const bsky = {
    hasAppPassword: false,
    ownerDid: async () => PUBLISHER,
    public: { app: { bsky: { feed: { getActorFeeds } } } },
  } as unknown as Bsky
  return { app: createApp({ config, engine, bsky }), posts }
}

const feedUri = (did = PUBLISHER, rkey = 'hello') => `at://${did}/app.bsky.feed.generator/${rkey}`

describe('feed generator endpoints', () => {
  it('serves a did:web document pointing at itself', async () => {
    const res = await setup().app.request('/.well-known/did.json')
    expect(await res.json()).toEqual({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:web:feeds.example.com',
      service: [{ id: '#bsky_fg', type: 'BskyFeedGenerator', serviceEndpoint: 'https://feeds.example.com' }],
    })
  })

  it('does not serve a DID document when using a non-web service DID', async () => {
    const res = await setup({ FEEDGEN_SERVICE_DID: 'did:plc:service' }).app.request('/.well-known/did.json')
    expect(res.status).toBe(404)
  })

  it('describes its feeds', async () => {
    const res = await setup().app.request('/xrpc/app.bsky.feed.describeFeedGenerator')
    expect(await res.json()).toEqual({ did: 'did:web:feeds.example.com', feeds: [{ uri: feedUri() }] })
  })

  it('returns a feed skeleton', async () => {
    const { app, posts } = setup()
    const res = await app.request(`/xrpc/app.bsky.feed.getFeedSkeleton?feed=${encodeURIComponent(feedUri())}&limit=10`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ feed: [{ post: posts[0]!.post.uri }] })
  })

  it('rejects feeds it does not serve', async () => {
    const { app } = setup()
    for (const uri of [feedUri('did:plc:someone-else'), feedUri(PUBLISHER, 'nope'), `at://${PUBLISHER}/app.bsky.feed.post/hello`]) {
      const res = await app.request(`/xrpc/app.bsky.feed.getFeedSkeleton?feed=${encodeURIComponent(uri)}`)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('UnknownFeed')
    }
  })

  it('rejects malformed cursors as bad requests', async () => {
    const res = await setup().app.request(`/xrpc/app.bsky.feed.getFeedSkeleton?feed=${encodeURIComponent(feedUri())}&cursor=xyz`)
    expect(res.status).toBe(400)
  })
})

describe('dashboard', () => {
  it('links published feeds to Bluesky', async () => {
    const { app } = setup({}, [{ rkey: 'hello', did: 'did:web:feeds.example.com', displayName: 'Hello' }])
    const html = await (await app.request('/')).text()
    expect(html).toContain('Live in Bluesky')
    expect(html).toContain(`https://bsky.app/profile/${PUBLISHER}/feed/hello`)
  })

  it("doesn't link feeds that aren't published, or that belong to another service", async () => {
    for (const published of [[], [{ rkey: 'hello', did: 'did:web:skyfeed.example', displayName: 'Other' }]]) {
      const html = await (await setup({}, published).app.request('/')).text()
      expect(html).toContain('Hello')
      expect(html).not.toContain(`/feed/hello"`)
    }
  })

  it('escapes post content', async () => {
    const { app, posts } = setup()
    ;(posts[0]!.post.record as { text: string }).text = '<script>alert(1)</script>'
    const html = await (await app.request('/feeds/hello')).text()
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&lt;script&gt;')
  })

  it('requires the admin token for ad-hoc previews', async () => {
    const { app } = setup()
    const body = JSON.stringify({ id: 'x', displayName: 'X', sources: [{ type: 'likes' }] })
    const denied = await app.request('/api/preview', { method: 'POST', body, headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' } })
    expect(denied.status).toBe(401)
    const allowed = await app.request('/api/preview', { method: 'POST', body, headers: { authorization: 'Bearer secret', 'content-type': 'application/json' } })
    expect(allowed.status).toBe(200)
    expect((await allowed.json()).items).toHaveLength(1)
  })

  it('disables the playground without an admin token', async () => {
    const res = await setup({ ADMIN_TOKEN: '' }).app.request('/api/preview', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(403)
  })
})
