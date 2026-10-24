import { describe, expect, it, vi } from 'vitest'
import { type FeedDefinitionInput, parseFeed } from '../src/feeds/define.js'
import { type EngineOptions, FeedEngine } from '../src/feeds/engine.js'
import { StaticRegistry } from '../src/feeds/registry.js'
import type { Candidate } from '../src/feeds/post.js'
import { rank } from '../src/feeds/rank.js'
import { NOW, candidate, makePost } from './helpers.js'

function setup(def: Partial<FeedDefinitionInput>, candidates: Candidate[][], overrides: Partial<EngineOptions> = {}) {
  let now = NOW
  const fetchSource = vi.fn(async (_source: unknown, _opts: unknown) => {
    const next = candidates[fetchSource.mock.calls.length - 1] ?? candidates.at(-1)!
    return next
  })
  const feed = parseFeed({ id: 'test', displayName: 'Test', sources: [{ type: 'likes' }], ...def })
  const engine = new FeedEngine(new StaticRegistry([feed]), {
    fetchSource,
    resolvePostUri: async (uri) => uri,
    hydratePosts: async (uris) => uris.map((uri) => makePost({ uri })),
    cacheSeconds: 60,
    staleSeconds: 600,
    now: () => now,
    ...overrides,
  })
  return { engine, fetchSource, advance: (seconds: number) => (now += seconds * 1000) }
}

describe('rank', () => {
  it('orders hot by engagement decayed by age', () => {
    const fresh = candidate(makePost({ hoursAgo: 1, likes: 10 }))
    const old = candidate(makePost({ hoursAgo: 48, likes: 100 }))
    const popular = candidate(makePost({ hoursAgo: 2, likes: 500 }))
    expect(rank([old, fresh, popular], 'hot', NOW)).toEqual([popular, fresh, old])
    expect(rank([old, fresh, popular], 'top', NOW)).toEqual([popular, old, fresh])
    expect(rank([old, fresh, popular], 'newest', NOW)).toEqual([fresh, popular, old])
  })
})

describe('FeedEngine.build', () => {
  it('dedupes posts across sources, preferring the original over a repost', async () => {
    const post = makePost()
    const repost = { ...candidate(post), repost: { uri: 'at://x/app.bsky.feed.repost/1', by: post.author, indexedAt: post.indexedAt } }
    const { engine } = setup({ sources: [{ type: 'likes' }, { type: 'likes' }] }, [[repost], [candidate(post)]])
    const built = await engine.get('test')
    expect(built.items).toHaveLength(1)
    expect(built.items[0]!.repost).toBeUndefined()
  })

  it('serves the sources that worked and reports the ones that failed', async () => {
    const { engine } = setup({ sources: [{ type: 'likes' }, { type: 'likes' }] }, [[candidate(makePost())]], {
      fetchSource: vi.fn().mockResolvedValueOnce([candidate(makePost())]).mockRejectedValueOnce(new Error('boom')),
    })
    const built = await engine.get('test')
    expect(built.items).toHaveLength(1)
    expect(built.errors).toEqual(['source #2 (likes): boom'])
  })

  it('fails when every source fails', async () => {
    const { engine } = setup({}, [], { fetchSource: vi.fn().mockRejectedValue(new Error('boom')) })
    await expect(engine.get('test')).rejects.toThrow(/Every source/)
  })

  it('passes maxAgeHours to sources so they can stop paging early', async () => {
    const { engine, fetchSource } = setup({ filters: { maxAgeHours: 2 } }, [[]])
    await engine.get('test')
    expect(fetchSource.mock.calls[0]![1]).toEqual({ since: NOW - 2 * 3_600_000 })
  })
})

describe('FeedEngine cache', () => {
  it('reuses results within the cache window', async () => {
    const { engine, fetchSource, advance } = setup({}, [[candidate(makePost())]])
    await engine.get('test')
    advance(59)
    await engine.get('test')
    expect(fetchSource).toHaveBeenCalledTimes(1)
  })

  it('serves stale results while refreshing', async () => {
    const first = [candidate(makePost({ text: 'first' }))]
    const second = [candidate(makePost({ text: 'second' }))]
    const { engine, fetchSource, advance } = setup({}, [first, second])
    await engine.get('test')
    advance(61)
    expect((await engine.get('test')).items).toEqual(first)
    await vi.waitFor(() => expect(fetchSource).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r))
    expect((await engine.get('test')).items).toEqual(second)
  })

  it('shares one in-flight build between concurrent requests', async () => {
    const { engine, fetchSource } = setup({}, [[candidate(makePost())]])
    await Promise.all([engine.get('test'), engine.get('test'), engine.get('test')])
    expect(fetchSource).toHaveBeenCalledTimes(1)
  })

  it('keeps serving the last good result when a refresh fails', async () => {
    const good = [candidate(makePost())]
    const fetchSource = vi.fn().mockResolvedValueOnce(good).mockRejectedValue(new Error('down'))
    const { engine, advance } = setup({}, [], { fetchSource })
    await engine.get('test')
    advance(3600)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await engine.get('test')).items).toEqual(good)
  })
})

describe('FeedEngine.skeleton', () => {
  const posts = Array.from({ length: 7 }, (_, i) => candidate(makePost({ hoursAgo: i + 1, likes: i })))

  it('pages through a chronological feed with time cursors', async () => {
    const { engine } = setup({}, [posts])
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await engine.skeleton('test', { limit: 3, cursor })
      seen.push(...page.feed.map((f) => f.post))
      cursor = page.cursor
    } while (cursor)
    expect(seen).toEqual(posts.map((c) => c.post.uri))
  })

  it("doesn't repeat posts when new ones arrive between pages", async () => {
    const { engine, advance } = setup({}, [posts.slice(1), posts])
    const first = await engine.skeleton('test', { limit: 3 })
    advance(3600) // the next request triggers a refresh that adds a newer post
    await engine.get('test')
    await new Promise((r) => setTimeout(r))
    const second = await engine.skeleton('test', { limit: 3, cursor: first.cursor })
    expect(second.feed.map((f) => f.post)).toEqual(posts.slice(4, 7).map((c) => c.post.uri))
  })

  it('uses offset cursors for ranked feeds', async () => {
    const { engine } = setup({ sort: 'top' }, [posts])
    const first = await engine.skeleton('test', { limit: 4 })
    expect(first.cursor).toBe('o:4')
    const second = await engine.skeleton('test', { limit: 4, cursor: first.cursor })
    expect(second.feed).toHaveLength(3)
    expect(second.cursor).toBeUndefined()
  })

  it('puts pinned posts on the first page only, with a pin reason', async () => {
    const pinned = 'at://did:plc:me/app.bsky.feed.post/pinned'
    const { engine } = setup({ pinned: [pinned] }, [posts])
    const first = await engine.skeleton('test', { limit: 3 })
    expect(first.feed[0]).toEqual({ post: pinned, reason: { $type: 'app.bsky.feed.defs#skeletonReasonPin' } })
    expect(first.feed).toHaveLength(3)
    const second = await engine.skeleton('test', { limit: 3, cursor: first.cursor })
    expect(second.feed.map((f) => f.post)).not.toContain(pinned)
    expect(second.feed[0]!.post).toBe(posts[2]!.post.uri)
  })

  it('marks reposts so Bluesky shows who reposted', async () => {
    const post = makePost()
    const repostUri = 'at://did:plc:bob/app.bsky.feed.repost/1'
    const { engine } = setup({}, [[{ ...candidate(post), repost: { uri: repostUri, by: post.author, indexedAt: post.indexedAt } }]])
    const page = await engine.skeleton('test', { limit: 10 })
    expect(page.feed[0]).toEqual({ post: post.uri, reason: { $type: 'app.bsky.feed.defs#skeletonReasonRepost', repost: repostUri } })
  })

  it('rejects malformed cursors', async () => {
    const { engine } = setup({}, [posts])
    await expect(engine.skeleton('test', { limit: 3, cursor: 'garbage' })).rejects.toThrow(/Malformed cursor/)
  })
})

describe('remembering posts', () => {
  /** A FeedMemory backed by a Map, like the database version. */
  function memory() {
    const saved = new Map<string, Candidate[]>()
    return {
      saved,
      load: async (id: string) => saved.get(id) ?? [],
      add: vi.fn(async (id: string, cs: Candidate[]) => void saved.set(id, [...(saved.get(id) ?? []), ...cs])),
    }
  }
  const older = candidate(makePost({ hoursAgo: 10, text: 'old match' }))
  const newer = candidate(makePost({ hoursAgo: 1, text: 'new match' }))

  it('keeps posts after the sources stop returning them', async () => {
    const mem = memory()
    const { engine, advance } = setup({ remember: true }, [[older], [newer]], { memory: mem })
    await engine.get('test')
    advance(3600)
    await engine.get('test') // serves stale, refreshes in the background
    await new Promise((r) => setTimeout(r))
    expect((await engine.get('test')).items.map((c) => c.post.uri)).toEqual([newer.post.uri, older.post.uri])
  })

  it('lets old posts drop off when remember is off', async () => {
    const mem = memory()
    const { engine, advance } = setup({}, [[older], [newer]], { memory: mem })
    await engine.get('test')
    advance(3600)
    await engine.get('test')
    await new Promise((r) => setTimeout(r))
    expect((await engine.get('test')).items.map((c) => c.post.uri)).toEqual([newer.post.uri])
    expect(mem.add).not.toHaveBeenCalled()
  })

  it('still applies the filters to remembered posts', async () => {
    const mem = memory()
    mem.saved.set('test', [older])
    const { engine } = setup({ remember: true, filters: { excludeKeywords: ['old'] } }, [[newer]], { memory: mem })
    expect((await engine.get('test')).items.map((c) => c.post.uri)).toEqual([newer.post.uri])
  })

  it("doesn't save anything during previews", async () => {
    const mem = memory()
    const { engine } = setup({ remember: true }, [[newer]], { memory: mem })
    const def = (await engine.feed('test'))!
    await engine.build(def, { readOnly: true })
    expect(mem.add).not.toHaveBeenCalled()
  })

  it('says so when there is nowhere to remember posts', async () => {
    const { engine } = setup({ remember: true }, [[newer]])
    expect((await engine.get('test')).errors.join()).toMatch(/without a database/)
  })
})
