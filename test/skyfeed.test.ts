import { describe, expect, it } from 'vitest'
import { parseFeed } from '../src/feeds/define.js'
import { compileFilters } from '../src/feeds/filters.js'
import { convertSkyfeed, parseImport } from '../src/feeds/skyfeed.js'
import { NOW, candidate, makePost } from './helpers.js'

const ME = 'did:plc:me'

describe('convertSkyfeed', () => {
  it('converts a feed of your own posts matching a regex', () => {
    const { feed, notes } = convertSkyfeed({
      displayName: 'Aural Vibes',
      blocks: [
        { type: 'input', inputType: 'did', did: ME },
        { type: 'regex', value: '💿 #', target: 'text', caseSensitive: false },
        { type: 'remember' },
        { type: 'sort', sortType: 'created_at' },
      ],
    })
    expect(feed).toEqual({
      displayName: 'Aural Vibes',
      sources: [{ type: 'author', actors: [ME], filter: 'posts_with_replies', limit: 1000 }],
      filters: { excludeReposts: true, includeRegex: '💿 #' },
      sort: 'newest',
    })
    // Remember is left for the owner to opt into.
    expect(feed.remember).toBeUndefined()
    expect(notes).toEqual([expect.stringContaining('Tick "Remember posts"')])

    const def = parseFeed({ ...feed, id: 'aural' })
    const keep = compileFilters(def.filters)
    expect(keep(candidate(makePost({ text: 'Now playing 💿 #NowPlaying' })), NOW)).toBe(true)
    expect(keep(candidate(makePost({ text: 'just a post' })), NOW)).toBe(false)
  })

  it('combines several regex filters the way SkyFeed applies them', () => {
    const { feed } = convertSkyfeed({
      blocks: [
        { type: 'input', inputType: 'did', did: ME },
        { type: 'regex', value: 'music' },
        { type: 'regex', value: 'live' },
        { type: 'regex', value: 'spam', invert: true },
        { type: 'regex', value: 'scam', invert: true },
      ],
    })
    const keep = compileFilters(parseFeed({ ...feed, id: 'x', displayName: 'X' }).filters)
    const ok = (text: string) => keep(candidate(makePost({ text })), NOW)
    expect(ok('live music tonight')).toBe(true)
    expect(ok('music only')).toBe(false)
    expect(ok('live music spam')).toBe(false)
    expect(ok('live music scam')).toBe(false)
  })

  it('converts list, feed and post inputs, and the common sorts and removals', () => {
    const { feed, notes } = convertSkyfeed({
      blocks: [
        { type: 'input', inputType: 'list', listUri: 'at://did:plc:a/app.bsky.graph.list/l1' },
        { type: 'input', inputType: 'feed', feedUri: 'at://did:plc:a/app.bsky.feed.generator/f1' },
        { type: 'input', inputType: 'post', postUri: 'at://did:plc:a/app.bsky.feed.post/p1' },
        { type: 'remove', subject: 'reply' },
        { type: 'sort', sortType: 'likes' },
        { type: 'limit', count: 100 },
      ],
    })
    expect(feed.sources).toEqual([
      { type: 'list', list: 'at://did:plc:a/app.bsky.graph.list/l1', limit: 300 },
      { type: 'feed', feed: 'at://did:plc:a/app.bsky.feed.generator/f1', limit: 300 },
      { type: 'posts', posts: ['at://did:plc:a/app.bsky.feed.post/p1'] },
    ])
    expect(feed).toMatchObject({ filters: { excludeReplies: true }, sort: 'top', maxPosts: 100 })
    expect(notes).toEqual([])
  })

  it('says what it could not convert', () => {
    const { feed, notes } = convertSkyfeed({
      blocks: [{ type: 'input', inputType: 'firehose' }, { type: 'mystery' }, { type: 'regex', value: 'x', caseSensitive: true, target: 'alt_text' }],
    })
    expect(notes.join('\n')).toMatch(/whole-network/)
    expect(notes.join('\n')).toMatch(/"mystery"/)
    expect(notes.join('\n')).toMatch(/case-sensitive/)
    expect(notes.join('\n')).toMatch(/No sources/)
    expect(feed.sources).toEqual([{ type: 'search' }])
  })
})

describe('parseImport', () => {
  it('recognises links, SkyFeed JSON and Feed Builder JSON', () => {
    expect(parseImport(' https://bsky.app/profile/me.test/feed/abc ')).toEqual({ kind: 'link', uri: 'https://bsky.app/profile/me.test/feed/abc' })
    expect(parseImport('{"blocks":[]}').kind).toBe('skyfeed')
    expect(parseImport('{"skyfeedBuilder":{"blocks":[]},"displayName":"X"}')).toMatchObject({ kind: 'skyfeed', record: { displayName: 'X' } })
    expect(parseImport('{"sources":[{"type":"likes"}]}').kind).toBe('feed')
  })

  it('rejects anything else', () => {
    expect(() => parseImport('hello')).toThrow(/feed link or valid JSON/)
    expect(() => parseImport('{"a":1}')).toThrow(/doesn't look like/)
  })
})
