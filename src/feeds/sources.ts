import type { AppBskyFeedDefs } from '@atproto/api'
import type { Bsky } from '../bsky.js'
import type { FeedSource } from './define.js'
import { type Candidate, fromFeedViewPost, fromPostView } from './post.js'

const PAGE_SIZE = 100
const MAX_PARALLEL_AUTHORS = 6

export interface FetchOptions {
  /** Candidates older than this are not needed, so paging can stop early. */
  since?: number
  /** The feed's account: search and likes run with its session, and likes are its likes. */
  owner?: string
}

export type SourceFetcher = (source: FeedSource, options: FetchOptions) => Promise<Candidate[]>

/** Pages through an endpoint until `limit` items are collected, the cursor runs out, or results get too old. */
async function paginate(
  limit: number,
  fetchPage: (cursor: string | undefined, pageSize: number) => Promise<{ items: Candidate[]; cursor?: string }>,
  since?: number,
): Promise<Candidate[]> {
  const all: Candidate[] = []
  let cursor: string | undefined
  do {
    const page = await fetchPage(cursor, Math.min(PAGE_SIZE, limit - all.length))
    all.push(...page.items)
    cursor = page.items.length ? page.cursor : undefined
    const oldest = page.items.at(-1)
    if (since !== undefined && oldest && oldest.sortAt < since) break
  } while (cursor && all.length < limit)
  return all.slice(0, limit)
}

async function mapLimit<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

const feedPage = (data: { feed: AppBskyFeedDefs.FeedViewPost[]; cursor?: string }) => ({
  items: data.feed.map(fromFeedViewPost),
  cursor: data.cursor,
})

export function createSourceFetcher(bsky: Bsky): SourceFetcher {
  return async (source, { since, owner }) => {
    switch (source.type) {
      case 'search': {
        const agent = await bsky.authedAgent('The search source', owner)
        const sinceIso = since !== undefined ? new Date(since).toISOString() : undefined
        // Search results are already newest-first for sort=latest; "top" results aren't ordered by time.
        return paginate(
          source.limit,
          async (cursor, limit) => {
            const { data } = await agent.app.bsky.feed.searchPosts({
              q: source.query,
              sort: source.sort,
              lang: source.lang,
              author: source.author,
              domain: source.domain,
              tag: source.tags,
              since: sinceIso,
              limit,
              cursor,
            })
            return { items: data.posts.map(fromPostView), cursor: data.cursor }
          },
          source.sort === 'latest' ? since : undefined,
        )
      }

      case 'author': {
        const perActor = await mapLimit(source.actors, MAX_PARALLEL_AUTHORS, (actor) =>
          paginate(
            source.limit,
            async (cursor, limit) =>
              feedPage(
                (await bsky.read((a) => a.app.bsky.feed.getAuthorFeed({ actor, filter: source.filter, limit, cursor }))).data,
              ),
            since,
          ).catch((err: unknown) => err as Error),
        )
        // One deleted or deactivated account shouldn't take down the whole source.
        const failures = perActor.filter((r) => r instanceof Error)
        if (failures.length === perActor.length) throw failures[0]
        for (const [i, r] of perActor.entries()) {
          if (r instanceof Error) console.warn(`Skipping posts by ${source.actors[i]}: ${r.message}`)
        }
        return perActor.flatMap((r) => (r instanceof Error ? [] : r))
      }

      case 'list': {
        const list = await bsky.toAtUri(source.list, 'app.bsky.graph.list')
        return paginate(
          source.limit,
          async (cursor, limit) => feedPage((await bsky.read((a) => a.app.bsky.feed.getListFeed({ list, limit, cursor }))).data),
          since,
        )
      }

      case 'feed': {
        const feed = await bsky.toAtUri(source.feed, 'app.bsky.feed.generator')
        // Custom feeds aren't necessarily chronological, so never stop paging early.
        return paginate(source.limit, async (cursor, limit) =>
          feedPage((await bsky.read((a) => a.app.bsky.feed.getFeed({ feed, limit, cursor }))).data),
        )
      }

      case 'likes': {
        const agent = await bsky.authedAgent('The likes source', owner)
        // Likes are ordered by when you liked them, not when the post was made.
        return paginate(source.limit, async (cursor, limit) =>
          feedPage((await agent.app.bsky.feed.getActorLikes({ actor: agent.assertDid, limit, cursor })).data),
        )
      }

      case 'posts': {
        const uris = await Promise.all(source.posts.map((p) => bsky.toAtUri(p, 'app.bsky.feed.post')))
        return (await hydratePosts(bsky, uris)).map(fromPostView)
      }
    }
  }
}

/** Fetches full post views for URIs, preserving order and skipping deleted posts. */
export async function hydratePosts(bsky: Bsky, uris: string[]): Promise<AppBskyFeedDefs.PostView[]> {
  const chunks: string[][] = []
  for (let i = 0; i < uris.length; i += 25) chunks.push(uris.slice(i, i + 25))
  const results = await Promise.all(chunks.map((chunk) => bsky.read((a) => a.app.bsky.feed.getPosts({ uris: chunk }))))
  const byUri = new Map(results.flatMap((r) => r.data.posts).map((p) => [p.uri, p]))
  return uris.flatMap((uri) => byUri.get(uri) ?? [])
}
