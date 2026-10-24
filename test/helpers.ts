import { createClient } from '@libsql/client'
import { Database } from '../src/db.js'
import type { Candidate, PostView } from '../src/feeds/post.js'

export const NOW = Date.parse('2026-10-24T12:00:00Z')
export const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

let counter = 0

export function makePost(
  opts: {
    uri?: string
    text?: string
    handle?: string
    hoursAgo?: number
    likes?: number
    reposts?: number
    replies?: number
    langs?: string[]
    reply?: boolean
    embed?: Record<string, unknown>
    labels?: string[]
    tags?: string[]
  } = {},
): PostView {
  const n = ++counter
  const handle = opts.handle ?? 'alice.test'
  const at = hoursAgo(opts.hoursAgo ?? 1)
  return {
    uri: opts.uri ?? `at://did:plc:${handle.split('.')[0]}/app.bsky.feed.post/${String(n).padStart(6, '0')}`,
    cid: `cid${n}`,
    author: { did: `did:plc:${handle.split('.')[0]}`, handle, labels: [] },
    record: {
      $type: 'app.bsky.feed.post',
      text: opts.text ?? '',
      createdAt: at,
      ...(opts.langs ? { langs: opts.langs } : {}),
      ...(opts.reply ? { reply: { root: {}, parent: {} } } : {}),
      ...(opts.tags ? { facets: opts.tags.map((tag) => ({ features: [{ $type: 'app.bsky.richtext.facet#tag', tag }] })) } : {}),
    },
    embed: opts.embed as PostView['embed'],
    likeCount: opts.likes ?? 0,
    repostCount: opts.reposts ?? 0,
    replyCount: opts.replies ?? 0,
    indexedAt: at,
    labels: (opts.labels ?? []).map((val) => ({ val, src: 'did:plc:labeler', uri: '', cts: at })),
  }
}

export const candidate = (post: PostView): Candidate => ({ post, sortAt: Date.parse(post.indexedAt) })

export const images = { $type: 'app.bsky.embed.images#view', images: [{ thumb: 't', fullsize: 'f', alt: 'a tabby cat' }] }
export const link = {
  $type: 'app.bsky.embed.external#view',
  external: { uri: 'https://example.com', title: 'Linked article', description: 'About otters' },
}

export function memoryDb(now: () => number = Date.now) {
  return new Database(createClient({ url: ':memory:' }), now)
}
