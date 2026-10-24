import { describe, expect, it } from 'vitest'
import { parseFeed } from '../src/feeds/define.js'
import { compileFilters, keywordMatcher } from '../src/feeds/filters.js'
import { NOW, candidate, images, link, makePost } from './helpers.js'

const filtersOf = (filters: Record<string, unknown>) =>
  parseFeed({ id: 'test', displayName: 'Test', sources: [{ type: 'likes' }], filters }).filters

const keeps = (filters: Record<string, unknown>, post = makePost()) => compileFilters(filtersOf(filters))(candidate(post), NOW)

describe('keywordMatcher', () => {
  const match = (keywords: string[], text: string, tags: string[] = []) => keywordMatcher(keywords)(text, new Set(tags))

  it('matches whole words, case-insensitively', () => {
    expect(match(['cat'], 'My CAT is asleep')).toBe(true)
    expect(match(['cat'], 'concatenate')).toBe(false)
    expect(match(['cat'], 'cats')).toBe(false)
  })

  it('supports trailing wildcards', () => {
    expect(match(['cat*'], 'cats everywhere')).toBe(true)
    expect(match(['cat*'], 'concat')).toBe(false)
  })

  it('matches phrases across any whitespace', () => {
    expect(match(['open source'], 'love open\nsource')).toBe(true)
  })

  it('matches hashtags in text and in facets', () => {
    expect(match(['#caturday'], 'happy #Caturday!')).toBe(true)
    expect(match(['#caturday'], 'happy caturday')).toBe(false)
    expect(match(['#caturday'], 'no tag in text', ['caturday'])).toBe(true)
  })

  it('treats regex characters literally', () => {
    expect(match(['c++'], 'I write c++ daily')).toBe(true)
    expect(match(['c++'], 'I write c daily')).toBe(false)
  })

  it('handles non-Latin scripts', () => {
    expect(match(['猫'], '猫が好き')).toBe(true)
    expect(match(['кот'], 'мой кот спит')).toBe(true)
  })
})

describe('compileFilters', () => {
  it('keeps everything with default filters', () => {
    expect(keeps({})).toBe(true)
  })

  it('searches alt text and link cards, not just post text', () => {
    expect(keeps({ includeKeywords: ['tabby'] }, makePost({ embed: images }))).toBe(true)
    expect(keeps({ includeKeywords: ['otters'] }, makePost({ embed: link }))).toBe(true)
  })

  it('applies exclude keywords after include keywords', () => {
    const filters = { includeKeywords: ['cat*'], excludeKeywords: ['catalog'] }
    expect(keeps(filters, makePost({ text: 'my cat' }))).toBe(true)
    expect(keeps(filters, makePost({ text: 'new cat catalog' }))).toBe(false)
  })

  it('filters by media and links', () => {
    expect(keeps({ media: 'images' }, makePost({ embed: images }))).toBe(true)
    expect(keeps({ media: 'images' }, makePost())).toBe(false)
    expect(keeps({ media: 'none' }, makePost({ embed: images }))).toBe(false)
    expect(keeps({ media: 'video' }, makePost({ embed: images }))).toBe(false)
    expect(keeps({ links: 'required' }, makePost({ embed: link }))).toBe(true)
    expect(keeps({ links: 'none' }, makePost({ embed: link }))).toBe(false)
  })

  it('sees media inside quote posts with media', () => {
    const embed = { $type: 'app.bsky.embed.recordWithMedia#view', record: {}, media: images }
    expect(keeps({ media: 'images' }, makePost({ embed }))).toBe(true)
    expect(keeps({ excludeQuotes: true }, makePost({ embed }))).toBe(false)
  })

  it('filters replies, age and engagement', () => {
    expect(keeps({ excludeReplies: true }, makePost({ reply: true }))).toBe(false)
    expect(keeps({ maxAgeHours: 24 }, makePost({ hoursAgo: 23 }))).toBe(true)
    expect(keeps({ maxAgeHours: 24 }, makePost({ hoursAgo: 25 }))).toBe(false)
    expect(keeps({ minLikes: 10 }, makePost({ likes: 9 }))).toBe(false)
    expect(keeps({ minLikes: 10 }, makePost({ likes: 10 }))).toBe(true)
  })

  it('filters by language, keeping posts with no language tag', () => {
    expect(keeps({ languages: ['en'] }, makePost({ langs: ['en-US'] }))).toBe(true)
    expect(keeps({ languages: ['en'] }, makePost({ langs: ['ja'] }))).toBe(false)
    expect(keeps({ languages: ['en'] }, makePost())).toBe(true)
  })

  it('filters authors by handle or DID', () => {
    const post = makePost({ handle: 'bob.test' })
    expect(keeps({ excludeAuthors: ['@Bob.test'] }, post)).toBe(false)
    expect(keeps({ excludeAuthors: ['did:plc:bob'] }, post)).toBe(false)
    expect(keeps({ includeAuthors: ['alice.test'] }, post)).toBe(false)
  })

  it('drops labeled posts', () => {
    expect(keeps({ excludeLabels: ['porn'] }, makePost({ labels: ['porn'] }))).toBe(false)
    expect(keeps({ excludeLabels: ['porn'] }, makePost({ labels: ['spam'] }))).toBe(true)
  })

  it('drops reposts when asked', () => {
    const post = makePost()
    const repost = { ...candidate(post), repost: { by: post.author, indexedAt: post.indexedAt } }
    expect(compileFilters(filtersOf({ excludeReposts: true }))(repost, NOW)).toBe(false)
  })

  it('runs custom filters last', () => {
    const keep = compileFilters(filtersOf({}), (post) => post.likeCount! > 5)
    expect(keep(candidate(makePost({ likes: 6 })), NOW)).toBe(true)
    expect(keep(candidate(makePost({ likes: 5 })), NOW)).toBe(false)
  })
})

describe('parseFeed', () => {
  it('rejects ids Bluesky would not accept as record keys', () => {
    const base = { displayName: 'X', sources: [{ type: 'likes' }] }
    expect(() => parseFeed({ ...base, id: 'Cats' })).toThrow(/id must be/)
    expect(() => parseFeed({ ...base, id: 'a-very-long-feed-id' })).toThrow(/id must be/)
    expect(parseFeed({ ...base, id: 'cats' }).sort).toBe('newest')
  })

  it('rejects invalid regular expressions up front', () => {
    expect(() => parseFeed({ id: 'x', displayName: 'X', sources: [{ type: 'likes' }], filters: { includeRegex: '(' } })).toThrow(
      /not a valid regular expression/,
    )
  })

  it('names the feed and the field in errors', () => {
    expect(() => parseFeed({ id: 'cats', displayName: 'Cats', sources: [{ type: 'search' }] })).toThrow(/Feed "cats".*\n[\s\S]*query/)
  })
})
