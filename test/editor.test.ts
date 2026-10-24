import { describe, expect, it } from 'vitest'
import { parseFeed } from '../src/feeds/define.js'
import { NEW_FEED, editorPage, formToDefinition } from '../src/web/editor.js'

const form = (fields: Record<string, string>) => {
  const data = new FormData()
  for (const [k, v] of Object.entries(fields)) data.append(k, v)
  return data
}

/** Pulls the submitted values out of rendered editor HTML, the way a browser would on submit. */
function submittedFields(html: string): FormData {
  const data = new FormData()
  const body = html.replace(/<template[\s\S]*?<\/template>/g, '')
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  for (const m of body.matchAll(/<input([^>]*)>/g)) {
    const attrs = m[1]!
    const name = attrs.match(/name="([^"]*)"/)?.[1]
    if (!name || /type="file"/.test(attrs)) continue
    if (/type="checkbox"/.test(attrs)) {
      if (/\bchecked\b/.test(attrs)) data.append(name, 'on')
      continue
    }
    data.append(name, decode(attrs.match(/value="([^"]*)"/)?.[1] ?? ''))
  }
  for (const m of body.matchAll(/<textarea[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/textarea>/g)) data.append(m[1]!, decode(m[2]!))
  for (const m of body.matchAll(/<select name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...m[2]!.matchAll(/<option value="([^"]*)"\s*(selected)?/g)]
    data.append(m[1]!, (options.find((o) => o[2]) ?? options[0])![1]!)
  }
  return data
}

describe('formToDefinition', () => {
  it('turns form fields into a valid definition', () => {
    const def = formToDefinition(
      form({
        id: 'cats',
        displayName: 'Cats',
        description: '',
        sort: 'hot',
        's.0.type': 'search',
        's.0.target': 'cat pictures',
        's.0.sort': 'top',
        's.0.tags': '#caturday, cute',
        's.0.limit': '',
        's.3.type': 'author',
        's.3.target': 'alice.bsky.social, bob.bsky.social\ncarol.test',
        's.3.filter': 'posts_no_replies',
        'f.includeKeywords': 'cat*\nkitten, #caturday',
        'f.media': 'images',
        'f.excludeReplies': 'on',
        'f.minLikes': '5',
        pinned: '',
      }),
    )
    expect(def).toEqual({
      id: 'cats',
      displayName: 'Cats',
      sort: 'hot',
      sources: [
        { type: 'search', query: 'cat pictures', sort: 'top', tags: ['caturday', 'cute'] },
        { type: 'author', actors: ['alice.bsky.social', 'bob.bsky.social', 'carol.test'], filter: 'posts_no_replies' },
      ],
      filters: { includeKeywords: ['cat*', 'kitten', '#caturday'], media: 'images', excludeReplies: true, minLikes: 5 },
    })
    expect(() => parseFeed(def)).not.toThrow()
  })

  it('keeps sources in index order, even with gaps from removed rows', () => {
    const def = formToDefinition(form({ 's.10.type': 'likes', 's.2.type': 'feed', 's.2.target': 'at://x/app.bsky.feed.generator/y' }))
    expect((def.sources as { type: string }[]).map((s) => s.type)).toEqual(['feed', 'likes'])
  })

  it('leaves bad numbers for validation to report', () => {
    const def = formToDefinition(form({ id: 'x', displayName: 'X', 's.0.type': 'likes', 'f.minLikes': 'lots' }))
    expect(() => parseFeed(def)).toThrow(/minLikes/)
  })
})

describe('editorPage', () => {
  const roundTrip = (feed: Record<string, unknown>) =>
    formToDefinition(submittedFields(String(editorPage({ viewer: { signedIn: true, canSignIn: true }, mode: 'edit', feed }))))

  it('submits back exactly the feed it was rendered with', () => {
    const feed = {
      id: 'everything',
      displayName: 'Every option',
      description: 'Uses "every" <field>',
      sort: 'top',
      sources: [
        { type: 'search', query: '"exact phrase" -nope', sort: 'top', lang: 'en', author: 'a.test', domain: 'github.com', tags: ['one', 'two'], limit: 250 },
        { type: 'author', actors: ['a.test', 'b.test'], filter: 'posts_with_media', limit: 20 },
        { type: 'list', list: 'https://bsky.app/profile/a.test/lists/abc', limit: 50 },
        { type: 'feed', feed: 'https://bsky.app/profile/bsky.app/feed/whats-hot' },
        { type: 'likes', limit: 30 },
        { type: 'posts', posts: ['at://did:plc:a/app.bsky.feed.post/1', 'at://did:plc:a/app.bsky.feed.post/2'] },
      ],
      filters: {
        includeKeywords: ['cat*', 'open source', '#tag'],
        excludeKeywords: ['dog'],
        includeRegex: '^\\d+',
        excludeRegex: 'spam|scam',
        languages: ['en', 'es'],
        media: 'video',
        links: 'none',
        excludeReplies: true,
        excludeReposts: true,
        excludeQuotes: true,
        minLikes: 1,
        minReposts: 2,
        minReplies: 3,
        maxAgeHours: 1.5,
        includeAuthors: ['a.test'],
        excludeAuthors: ['b.test'],
        excludeLabels: ['porn', 'spam'],
      },
      pinned: ['at://did:plc:a/app.bsky.feed.post/3'],
      maxPosts: 100,
      cacheSeconds: 30,
      remember: true,
    }
    expect(roundTrip(feed)).toEqual(feed)
  })

  it('starts new feeds from a valid template once named', () => {
    const def: Record<string, unknown> = { ...roundTrip(NEW_FEED), id: 'x', displayName: 'X' }
    ;(def.sources as Record<string, unknown>[])[0]!.query = 'cats'
    expect(() => parseFeed(def)).not.toThrow()
  })

  it('escapes submitted values', () => {
    const html = String(editorPage({ viewer: { signedIn: true, canSignIn: true }, mode: 'new', feed: { displayName: '"><script>x</script>' } }))
    expect(html).not.toContain('<script>x')
  })
})
