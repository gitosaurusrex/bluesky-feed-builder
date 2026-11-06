import { describe, expect, it, vi } from 'vitest'
import type { StoredFeed } from '../src/db.js'
import { parseFeed } from '../src/feeds/define.js'
import { CombinedRegistry } from '../src/feeds/registry.js'

const code = parseFeed({ id: 'code', displayName: 'Code', sources: [{ type: 'likes' }] })
const stored = (id: string, definition: unknown, updatedAt = 1): StoredFeed => ({ owner: 'me', id, definition, createdAt: 1, updatedAt })
const valid = (id: string) => ({ id, displayName: id, sources: [{ type: 'likes' }] })

describe('CombinedRegistry', () => {
  it('lists code feeds first, then saved feeds', async () => {
    const registry = new CombinedRegistry([code], { listFeeds: async () => [stored('saved', valid('saved'), 7)] })
    const feeds = await registry.list()
    expect(feeds.map((f) => [f.def.id, f.origin, f.version])).toEqual([
      ['code', 'code', 'code'],
      ['saved', 'editor', '7'],
    ])
  })

  it('lets code feeds win over saved feeds with the same id', async () => {
    const registry = new CombinedRegistry([code], { listFeeds: async () => [stored('code', valid('code'))] })
    expect((await registry.list()).map((f) => f.origin)).toEqual(['code'])
  })

  it('reports saved feeds that no longer validate', async () => {
    const registry = new CombinedRegistry([], { listFeeds: async () => [stored('bad', { id: 'bad' })] })
    const snapshot = await registry.snapshot()
    expect(snapshot.feeds).toEqual([])
    expect(snapshot.broken[0]).toMatchObject({ owner: 'me', id: 'bad' })
  })

  it('re-reads the database only after the TTL, or when invalidated', async () => {
    let now = 0
    const listFeeds = vi.fn(async () => [])
    const registry = new CombinedRegistry([], { listFeeds }, 1000, () => now)
    await registry.list()
    now = 999
    await registry.list()
    expect(listFeeds).toHaveBeenCalledTimes(1)
    now = 1000
    await registry.list()
    registry.invalidate()
    await registry.list()
    expect(listFeeds).toHaveBeenCalledTimes(3)
  })

  it('keeps serving the last known feeds when the database is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const listFeeds = vi.fn().mockResolvedValueOnce([stored('saved', valid('saved'))]).mockRejectedValue(new Error('down'))
    const registry = new CombinedRegistry([code], { listFeeds }, 0)
    await registry.list()
    expect((await registry.list()).map((f) => f.def.id)).toEqual(['code', 'saved'])
  })
})
