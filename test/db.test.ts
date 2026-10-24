import { describe, expect, it } from 'vitest'
import { memoryDb } from './helpers.js'

describe('Database feeds', () => {
  it('creates, lists, updates and deletes feeds', async () => {
    let now = 1000
    const db = memoryDb(() => now)
    await db.createFeed('cats', { id: 'cats', displayName: 'Cats' })
    expect(await db.listFeeds()).toEqual([{ id: 'cats', definition: { id: 'cats', displayName: 'Cats' }, createdAt: 1000, updatedAt: 1000 }])

    await db.updateFeed('cats', { id: 'cats', displayName: 'More cats' })
    expect((await db.getFeed('cats'))?.definition).toEqual({ id: 'cats', displayName: 'More cats' })

    await db.deleteFeed('cats')
    expect(await db.getFeed('cats')).toBeUndefined()
  })

  it('refuses duplicate ids', async () => {
    const db = memoryDb()
    await db.createFeed('cats', {})
    await expect(db.createFeed('cats', {})).rejects.toThrow(/already exists/)
  })

  it('bumps the version on every update, even within the same millisecond', async () => {
    const db = memoryDb(() => 5000)
    await db.createFeed('cats', {})
    await db.updateFeed('cats', { a: 1 })
    await db.updateFeed('cats', { a: 2 })
    expect((await db.getFeed('cats'))?.updatedAt).toBe(5002)
  })
})

describe('Database kv', () => {
  it('stores values per namespace', async () => {
    const db = memoryDb()
    await db.kv('a').set('k', { n: 1 })
    expect(await db.kv('a').get('k')).toEqual({ n: 1 })
    expect(await db.kv('b').get('k')).toBeUndefined()
    await db.kv('a').del('k')
    expect(await db.kv('a').get('k')).toBeUndefined()
  })

  it('expires values', async () => {
    let now = 0
    const db = memoryDb(() => now)
    const store = db.kv<string>('state', 1000)
    await store.set('k', 'v')
    now = 999
    expect(await store.get('k')).toBe('v')
    now = 1000
    expect(await store.get('k')).toBeUndefined()
  })
})

describe('Database.withLock', () => {
  it('runs one holder at a time', async () => {
    const db = memoryDb()
    const events: string[] = []
    const task = (name: string) =>
      db.withLock('refresh', async () => {
        events.push(`${name} start`)
        await new Promise((r) => setTimeout(r, 20))
        events.push(`${name} end`)
      })
    await Promise.all([task('a'), task('b')])
    expect(events).toEqual([events[0], events[0]!.replace('start', 'end'), events[2], events[2]!.replace('start', 'end')])
  })

  it('takes over a lock whose holder died', async () => {
    let now = 0
    const db = memoryDb(() => now)
    // Simulate a crashed holder: acquire, then never release.
    const stuck = db.withLock('refresh', () => new Promise(() => {}), { ttlMs: 1000 })
    void stuck
    await new Promise((r) => setTimeout(r, 10))
    now = 1001
    await expect(db.withLock('refresh', () => 'ok', { waitMs: 500 })).resolves.toBe('ok')
  })

  it('releases the lock when the task throws', async () => {
    const db = memoryDb()
    await expect(db.withLock('x', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(db.withLock('x', () => 'free', { waitMs: 0 })).resolves.toBe('free')
  })
})
