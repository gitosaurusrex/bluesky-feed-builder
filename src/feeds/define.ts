import { z } from 'zod'
import type { AppBskyFeedDefs } from '@atproto/api'

const limit = (fallback: number) => z.number().int().min(1).max(1000).default(fallback)

const regex = z.string().refine(
  (source) => {
    try {
      new RegExp(source, 'iu')
      return true
    } catch {
      return false
    }
  },
  { message: 'not a valid regular expression' },
)

/**
 * Where candidate posts come from. Every source is fetched on demand from the
 * Bluesky AppView, so no firehose consumer or database is needed.
 */
export const sourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('search'),
    /** Search query. Lucene-ish syntax: `"exact phrase"`, `-exclude`, `from:handle`. */
    query: z.string().min(1),
    sort: z.enum(['latest', 'top']).default('latest'),
    lang: z.string().optional(),
    /** Only posts by this handle or DID. */
    author: z.string().optional(),
    /** Only posts linking to this domain, e.g. `github.com`. */
    domain: z.string().optional(),
    /** Only posts carrying all of these hashtags (without `#`). */
    tags: z.array(z.string()).optional(),
    limit: limit(100),
  }),
  z.object({
    type: z.literal('author'),
    /** Handles or DIDs whose posts to include. */
    actors: z.array(z.string()).min(1),
    filter: z
      .enum(['posts_with_replies', 'posts_no_replies', 'posts_with_media', 'posts_and_author_threads', 'posts_with_video'])
      .default('posts_and_author_threads'),
    /** Max posts fetched per actor. */
    limit: limit(50),
  }),
  z.object({
    type: z.literal('list'),
    /** A list's at:// URI or its bsky.app URL. Includes posts by every list member. */
    list: z.string(),
    limit: limit(100),
  }),
  z.object({
    type: z.literal('feed'),
    /** Another feed's at:// URI or bsky.app URL, used as raw material. */
    feed: z.string(),
    limit: limit(100),
  }),
  z.object({
    type: z.literal('likes'),
    /** Posts liked by the account in BSKY_IDENTIFIER (Bluesky only exposes your own likes). */
    limit: limit(100),
  }),
  z.object({
    type: z.literal('posts'),
    /** Hand-picked posts, as at:// URIs or bsky.app URLs. */
    posts: z.array(z.string()).min(1).max(250),
  }),
])

export const filtersSchema = z
  .object({
    /** Keep posts matching at least one. Whole-word, case-insensitive; `#tag` and trailing `*` wildcards work. */
    includeKeywords: z.array(z.string().min(1)).optional(),
    /** Drop posts matching any. Same syntax as includeKeywords. */
    excludeKeywords: z.array(z.string().min(1)).optional(),
    /** JavaScript regular expressions (case-insensitive) tested against the post text. */
    includeRegex: regex.optional(),
    excludeRegex: regex.optional(),
    /** Keep posts tagged with one of these languages. Posts with no language tag are kept. */
    languages: z.array(z.string()).optional(),
    media: z.enum(['any', 'required', 'images', 'video', 'none']).default('any'),
    links: z.enum(['any', 'required', 'none']).default('any'),
    excludeReplies: z.boolean().default(false),
    excludeReposts: z.boolean().default(false),
    excludeQuotes: z.boolean().default(false),
    minLikes: z.number().int().min(0).default(0),
    minReposts: z.number().int().min(0).default(0),
    minReplies: z.number().int().min(0).default(0),
    maxAgeHours: z.number().positive().optional(),
    /** Only keep posts by these handles or DIDs. */
    includeAuthors: z.array(z.string()).optional(),
    excludeAuthors: z.array(z.string()).optional(),
    /** Drop posts or authors carrying any of these labels, e.g. `porn`, `sexual`, `nudity`, `graphic-media`. */
    excludeLabels: z.array(z.string()).optional(),
  })
  .prefault({})

export const feedSchema = z.object({
  /** Record key of the feed. Shows up in the feed URL; keep it stable once published. */
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,14}$/, 'id must be 1-15 characters of lowercase letters, digits and dashes'),
  displayName: z.string().min(1).max(24),
  description: z.string().max(300).optional(),
  /** Path to a PNG or JPEG, relative to the project root, uploaded by `npm run publish-feeds`. */
  avatar: z.string().optional(),
  sources: z.array(sourceSchema).min(1),
  filters: filtersSchema,
  sort: z.enum(['newest', 'top', 'hot']).default('newest'),
  /** Posts (at:// URIs or bsky.app URLs) pinned to the top of the feed. */
  pinned: z.array(z.string()).max(10).default([]),
  /** Upper bound on how many posts the feed holds after filtering. */
  maxPosts: z.number().int().min(1).max(2000).default(500),
  /** How long fetched results are reused before refetching. Defaults to CACHE_SECONDS. */
  cacheSeconds: z.number().int().min(0).optional(),
})

export type FeedSource = z.output<typeof sourceSchema>
export type FeedFilters = z.output<typeof filtersSchema>

/** Escape hatch for logic the declarative filters can't express. Return false to drop the post. */
export type CustomFilter = (post: AppBskyFeedDefs.PostView, info: { isRepost: boolean }) => boolean

export type FeedDefinitionInput = z.input<typeof feedSchema> & { filter?: CustomFilter }
export type FeedDefinition = z.output<typeof feedSchema> & { filter?: CustomFilter }

/** Identity helper that gives feed files type checking and editor autocompletion. */
export function defineFeed(def: FeedDefinitionInput): FeedDefinitionInput {
  return def
}

export class FeedValidationError extends Error {}

export function parseFeed(input: unknown): FeedDefinition {
  const result = feedSchema.safeParse(input)
  if (!result.success) {
    const id = (input as { id?: unknown } | null)?.id
    const label = typeof id === 'string' ? `Feed "${id}"` : 'Feed definition'
    throw new FeedValidationError(`${label} is invalid:\n${z.prettifyError(result.error)}`)
  }
  const filter = (input as { filter?: unknown }).filter
  return typeof filter === 'function' ? { ...result.data, filter: filter as CustomFilter } : result.data
}

export function parseFeeds(inputs: FeedDefinitionInput[]): FeedDefinition[] {
  const feeds = inputs.map(parseFeed)
  const seen = new Set<string>()
  for (const feed of feeds) {
    if (seen.has(feed.id)) throw new FeedValidationError(`Duplicate feed id "${feed.id}"`)
    seen.add(feed.id)
  }
  return feeds
}
