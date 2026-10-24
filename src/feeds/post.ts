import type { AppBskyActorDefs, AppBskyFeedDefs } from '@atproto/api'

export type PostView = AppBskyFeedDefs.PostView

/** A post on its way through the pipeline, plus the repost that surfaced it, if any. */
export interface Candidate {
  post: PostView
  repost?: { uri?: string; by: AppBskyActorDefs.ProfileViewBasic; indexedAt: string }
  /** Milliseconds since epoch used for ordering: when the post (or repost) appeared. */
  sortAt: number
}

interface PostRecord {
  text?: string
  langs?: string[]
  tags?: string[]
  reply?: unknown
  createdAt?: string
  facets?: { features?: { $type?: string; tag?: string; uri?: string }[] }[]
}

export function postRecord(post: PostView): PostRecord {
  return (post.record ?? {}) as PostRecord
}

/**
 * Bluesky orders by the earlier of createdAt and indexedAt, so a post can't
 * jump the queue by claiming a future createdAt.
 */
export function sortAtOf(post: PostView): number {
  const indexed = Date.parse(post.indexedAt)
  const created = Date.parse(postRecord(post).createdAt ?? '')
  if (Number.isNaN(created)) return indexed
  if (Number.isNaN(indexed)) return created
  return Math.min(created, indexed)
}

export function fromPostView(post: PostView): Candidate {
  return { post, sortAt: sortAtOf(post) }
}

export function fromFeedViewPost(item: AppBskyFeedDefs.FeedViewPost): Candidate {
  const reason = item.reason as { $type?: string; uri?: string; by?: AppBskyActorDefs.ProfileViewBasic; indexedAt?: string } | undefined
  if (reason?.$type === 'app.bsky.feed.defs#reasonRepost' && reason.by && reason.indexedAt) {
    return {
      post: item.post,
      repost: { uri: reason.uri, by: reason.by, indexedAt: reason.indexedAt },
      sortAt: Date.parse(reason.indexedAt),
    }
  }
  return fromPostView(item.post)
}

type Embed = { $type?: string; [key: string]: unknown }

/** Media and quote embeds may be nested inside recordWithMedia; this flattens them. */
function embedsOf(post: PostView): Embed[] {
  const embed = post.embed as Embed | undefined
  if (!embed) return []
  if (embed.$type === 'app.bsky.embed.recordWithMedia#view') {
    return [embed, ...(embed.media ? [embed.media as Embed] : [])]
  }
  return [embed]
}

export interface PostFeatures {
  /** Text, image alt text and link card title/description, used for keyword matching. */
  searchText: string
  tags: Set<string>
  hasImages: boolean
  hasVideo: boolean
  hasLinks: boolean
  isReply: boolean
  isQuote: boolean
  langs: string[]
}

export function featuresOf(post: PostView): PostFeatures {
  const record = postRecord(post)
  const text: string[] = [record.text ?? '']
  const tags = new Set((record.tags ?? []).map((t) => t.toLowerCase()))
  let hasLinks = false
  for (const facet of record.facets ?? []) {
    for (const feature of facet.features ?? []) {
      if (feature.$type === 'app.bsky.richtext.facet#tag' && feature.tag) tags.add(feature.tag.toLowerCase())
      if (feature.$type === 'app.bsky.richtext.facet#link') hasLinks = true
    }
  }

  let hasImages = false
  let hasVideo = false
  let isQuote = false
  for (const embed of embedsOf(post)) {
    switch (embed.$type) {
      case 'app.bsky.embed.images#view':
        hasImages = true
        for (const image of (embed.images as { alt?: string }[] | undefined) ?? []) text.push(image.alt ?? '')
        break
      case 'app.bsky.embed.video#view':
        hasVideo = true
        text.push((embed.alt as string | undefined) ?? '')
        break
      case 'app.bsky.embed.external#view': {
        hasLinks = true
        const external = embed.external as { title?: string; description?: string } | undefined
        text.push(external?.title ?? '', external?.description ?? '')
        break
      }
      case 'app.bsky.embed.record#view':
      case 'app.bsky.embed.recordWithMedia#view':
        isQuote = true
        break
    }
  }

  return {
    searchText: text.filter(Boolean).join('\n'),
    tags,
    hasImages,
    hasVideo,
    hasLinks,
    isReply: record.reply !== undefined,
    isQuote,
    langs: record.langs ?? [],
  }
}

export function engagementOf(post: PostView): number {
  return (post.likeCount ?? 0) + 2 * ((post.repostCount ?? 0) + (post.quoteCount ?? 0)) + (post.replyCount ?? 0)
}
