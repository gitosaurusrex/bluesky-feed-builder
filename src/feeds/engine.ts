import type { AppBskyFeedDefs } from '@atproto/api'
import type { FeedDefinition } from './define.js'
import { feedKey } from '../db.js'
import { compileFilters } from './filters.js'
import type { Candidate, PostView } from './post.js'
import { compareNewest, rank } from './rank.js'
import type { FeedRegistry, RegisteredFeed } from './registry.js'
import type { SourceFetcher } from './sources.js'

export interface BuiltFeed {
  items: Candidate[]
  /** at:// URIs of pinned posts, shown on the first page only. */
  pinned: string[]
  /** Sources that failed. The feed is still served from the ones that worked. */
  errors: string[]
  builtAt: number
}

export interface SkeletonPage {
  feed: AppBskyFeedDefs.SkeletonFeedPost[]
  cursor?: string
}

export interface PreviewResult {
  pinned: PostView[]
  items: Candidate[]
  errors: string[]
  builtAt: number
}

export interface EngineOptions {
  fetchSource: SourceFetcher
  resolvePostUri: (input: string) => Promise<string>
  hydratePosts: (uris: string[]) => Promise<PostView[]>
  cacheSeconds: number
  staleSeconds: number
  /** Keeps a background refresh alive after the response is sent (Vercel's waitUntil). */
  waitUntil?: (promise: Promise<unknown>) => void
  /** Storage for feeds with `remember` on. Without it, those feeds only show what their sources return. */
  memory?: FeedMemory
  now?: () => number
}

export interface FeedMemory {
  load(feedId: string): Promise<Candidate[]>
  add(feedId: string, candidates: Candidate[]): Promise<void>
}

interface CacheEntry {
  version: string
  value?: BuiltFeed
  refreshing?: Promise<BuiltFeed>
  refreshStartedAt?: number
}

/** A refresh that hasn't settled after this long is assumed lost (e.g. a frozen serverless instance). */
const REFRESH_TIMEOUT_MS = 30_000

export class FeedError extends Error {
  constructor(
    readonly code: 'UnknownFeed' | 'BadCursor' | 'FeedUnavailable',
    message: string,
  ) {
    super(message)
  }
}

export class FeedEngine {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly now: () => number

  constructor(
    readonly registry: FeedRegistry,
    private readonly options: EngineOptions,
  ) {
    this.now = options.now ?? Date.now
  }

  /** Every feed, with the account it belongs to. */
  feeds(): Promise<RegisteredFeed[]> {
    return this.registry.list()
  }

  async feed(owner: string, id: string): Promise<FeedDefinition | undefined> {
    return (await this.registry.get(owner, id))?.def
  }

  private async registered(owner: string, id: string): Promise<RegisteredFeed> {
    const feed = await this.registry.get(owner, id)
    if (!feed) throw new FeedError('UnknownFeed', `Unknown feed "${id}"`)
    return feed
  }

  /**
   * Fetches, merges, filters and ranks a feed without touching the cache.
   * `owner` is the account whose session runs sign-in-only sources, such as
   * search and likes. Previews pass `readOnly` so trying out a definition never
   * adds to what a feed remembers.
   */
  async build(def: FeedDefinition, { owner = '', readOnly = false }: { owner?: string; readOnly?: boolean } = {}): Promise<BuiltFeed> {
    const now = this.now()
    const since = def.filters.maxAgeHours ? now - def.filters.maxAgeHours * 3_600_000 : undefined
    const keep = compileFilters(def.filters, def.filter)

    const [pinned, ...results] = await Promise.allSettled([
      Promise.all(def.pinned.map(this.options.resolvePostUri)),
      ...def.sources.map((source) => this.options.fetchSource(source, { since, owner: owner || undefined })),
    ])

    const errors: string[] = []
    const merged = new Map<string, Candidate>()
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        errors.push(`source #${i + 1} (${def.sources[i]!.type}): ${messageOf(result.reason)}`)
        return
      }
      for (const candidate of result.value) {
        const existing = merged.get(candidate.post.uri)
        // When a post shows up both directly and as a repost, prefer the original.
        if (!existing || (existing.repost && !candidate.repost)) merged.set(candidate.post.uri, candidate)
      }
    })
    if (errors.length === def.sources.length) {
      throw new FeedError('FeedUnavailable', `Every source of feed "${def.id}" failed:\n${errors.join('\n')}`)
    }
    if (pinned.status === 'rejected') errors.push(`pinned posts: ${messageOf(pinned.reason)}`)

    const pinnedUris = pinned.status === 'fulfilled' ? pinned.value : []
    const pinnedSet = new Set(pinnedUris)
    let kept = [...merged.values()].filter((c) => !pinnedSet.has(c.post.uri) && keep(c, now))
    if (def.remember) kept = await this.withRemembered(feedKey(owner, def.id), kept, { keep, now, pinnedSet, errors, readOnly })
    return { items: rank(kept, def.sort, now).slice(0, def.maxPosts), pinned: pinnedUris, errors, builtAt: now }
  }

  /** Saves newly matched posts and adds back remembered ones that the sources no longer return. */
  private async withRemembered(
    key: string,
    fresh: Candidate[],
    ctx: { keep: (c: Candidate, now: number) => boolean; now: number; pinnedSet: Set<string>; errors: string[]; readOnly: boolean },
  ): Promise<Candidate[]> {
    const memory = this.options.memory
    if (!memory) {
      ctx.errors.push("remember: this feed can't remember posts without a database (TURSO_DATABASE_URL)")
      return fresh
    }
    try {
      const remembered = await memory.load(key)
      const known = new Set(remembered.map((c) => c.post.uri))
      const added = fresh.filter((c) => !known.has(c.post.uri))
      if (added.length && !ctx.readOnly) await memory.add(key, added)
      // Fresh copies win, since their like and repost counts are current. Old posts still have to pass the filters.
      const freshUris = new Set(fresh.map((c) => c.post.uri))
      const older = remembered.filter((c) => !freshUris.has(c.post.uri) && !ctx.pinnedSet.has(c.post.uri) && ctx.keep(c, ctx.now))
      return [...fresh, ...older]
    } catch (err) {
      ctx.errors.push(`remembered posts: ${messageOf(err)}`)
      return fresh
    }
  }

  /** Returns the cached build, serving stale results while refreshing in the background. */
  async get(owner: string, id: string): Promise<BuiltFeed> {
    return this.getBuilt(await this.registered(owner, id))
  }

  private async getBuilt({ def, version, owner }: RegisteredFeed): Promise<BuiltFeed> {
    const id = def.id
    const key = feedKey(owner, id)
    let entry = this.cache.get(key)
    // An edited feed starts over instead of serving results built from its old definition.
    if (!entry || entry.version !== version) {
      entry = { version }
      this.cache.set(key, entry)
    }

    const now = this.now()
    const ttl = (def.cacheSeconds ?? this.options.cacheSeconds) * 1000
    const age = entry.value ? now - entry.value.builtAt : Infinity
    if (age < ttl) return entry.value!

    const stuck = entry.refreshStartedAt !== undefined && now - entry.refreshStartedAt > REFRESH_TIMEOUT_MS
    if (!entry.refreshing || stuck) {
      entry.refreshStartedAt = now
      const target = entry
      const refreshing = this.build(def, { owner })
        .then((value) => {
          target.value = value
          return value
        })
        .finally(() => {
          if (target.refreshing === refreshing) {
            target.refreshing = undefined
            target.refreshStartedAt = undefined
          }
        })
      entry.refreshing = refreshing
    }

    if (entry.value && age < ttl + this.options.staleSeconds * 1000) {
      const background = entry.refreshing.catch((err) => console.error(`Refreshing feed "${id}" failed:`, err))
      this.options.waitUntil?.(background)
      return entry.value
    }
    try {
      return await entry.refreshing
    } catch (err) {
      // Better to serve something old than an error.
      if (entry.value) {
        console.error(`Refreshing feed "${id}" failed, serving cached copy:`, err)
        return entry.value
      }
      throw err
    }
  }

  /** Builds the `app.bsky.feed.getFeedSkeleton` response for one page. */
  async skeleton(owner: string, id: string, params: { limit: number; cursor?: string }): Promise<SkeletonPage> {
    const feed = await this.registered(owner, id)
    return paginate(await this.getBuilt(feed), feed.def.sort, params)
  }

  /** Posts for the dashboard preview, hydrated the same way a Bluesky client would see them. */
  async preview(owner: string, id: string, count = 30): Promise<PreviewResult> {
    return this.hydrate(await this.get(owner, id), count)
  }

  async hydrate(built: BuiltFeed, count = 30): Promise<PreviewResult> {
    const pinned = built.pinned.length ? await this.options.hydratePosts(built.pinned).catch(() => []) : []
    return { pinned, items: built.items.slice(0, count), errors: built.errors, builtAt: built.builtAt }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Cursors are opaque to Bluesky. Chronological feeds use the position of the
 * last post (`t:<sortAt>:<uri>`), which stays correct as new posts arrive.
 * Ranked feeds reshuffle constantly, so they use a plain offset (`o:<n>`).
 */
export function paginate(
  built: BuiltFeed,
  sort: FeedDefinition['sort'],
  { limit, cursor }: { limit: number; cursor?: string },
): SkeletonPage {
  const { items } = built
  let start = 0
  if (cursor) {
    const time = cursor.match(/^t:(\d+):(at:\/\/.+)$/)
    const offset = cursor.match(/^o:(\d+)$/)
    if (time) {
      const marker = { sortAt: Number(time[1]), post: { uri: time[2]! } } as Candidate
      start = items.findIndex((c) => compareNewest(c, marker) > 0)
      if (start === -1) start = items.length
    } else if (offset) {
      start = Number(offset[1])
    } else {
      throw new FeedError('BadCursor', 'Malformed cursor')
    }
  }

  const pinned = cursor ? [] : built.pinned.slice(0, limit)
  const page = items.slice(start, start + Math.max(0, limit - pinned.length))
  const feed: AppBskyFeedDefs.SkeletonFeedPost[] = [
    ...pinned.map((post) => ({ post, reason: { $type: 'app.bsky.feed.defs#skeletonReasonPin' as const } })),
    ...page.map((c) => ({
      post: c.post.uri,
      ...(c.repost?.uri ? { reason: { $type: 'app.bsky.feed.defs#skeletonReasonRepost' as const, repost: c.repost.uri } } : {}),
    })),
  ]

  const end = start + page.length
  const last = page.at(-1)
  let next: string | undefined
  if (end < items.length) {
    next = sort === 'newest' && last ? `t:${last.sortAt}:${last.post.uri}` : `o:${end}`
  }
  return { feed, cursor: next }
}
