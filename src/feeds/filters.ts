import type { FeedDefinition, FeedFilters } from './define.js'
import { type Candidate, featuresOf } from './post.js'

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u

/**
 * Builds a case-insensitive whole-word matcher. `cat*` matches "cats" and
 * "caterpillar"; `#cat` also matches posts carrying the tag in their facets.
 */
export function keywordMatcher(keywords: string[]): (text: string, tags: Set<string>) => boolean {
  const tags = keywords.filter((k) => k.startsWith('#')).map((k) => k.slice(1).toLowerCase())
  const pattern = (k: string) => {
    const wildcard = k.endsWith('*')
    const body = escapeRegex(wildcard ? k.slice(0, -1) : k).replace(/\s+/g, '\\s+')
    return wildcard ? `${body}[\\p{L}\\p{N}_]*` : body
  }
  // Chinese, Japanese and Thai don't separate words with spaces, so those keywords match anywhere.
  const unspaced = keywords.filter((k) => UNSPACED_SCRIPT.test(k))
  const spaced = keywords.filter((k) => !UNSPACED_SCRIPT.test(k))
  const alternatives = [
    ...(spaced.length ? [`(?<![\\p{L}\\p{N}_#])(?:${spaced.map(pattern).join('|')})(?![\\p{L}\\p{N}_])`] : []),
    ...unspaced.map(pattern),
  ]
  const re = new RegExp(alternatives.join('|'), 'iu')
  return (text, postTags) => re.test(text) || tags.some((t) => postTags.has(t))
}

const normalizeActor = (actor: string) => actor.trim().replace(/^@/, '').toLowerCase()
/** `en-US` and `en` both count as English. */
const baseLanguage = (lang: string) => lang.toLowerCase().split('-')[0]!

export type CandidatePredicate = (candidate: Candidate, now: number) => boolean

/** Compiles a feed's filters once so they can be applied cheaply to every candidate. */
export function compileFilters(filters: FeedFilters, custom?: FeedDefinition['filter']): CandidatePredicate {
  const include = filters.includeKeywords?.length ? keywordMatcher(filters.includeKeywords) : undefined
  const exclude = filters.excludeKeywords?.length ? keywordMatcher(filters.excludeKeywords) : undefined
  const includeRe = filters.includeRegex ? new RegExp(filters.includeRegex, 'iu') : undefined
  const excludeRe = filters.excludeRegex ? new RegExp(filters.excludeRegex, 'iu') : undefined
  const languages = filters.languages?.map(baseLanguage)
  const includeAuthors = filters.includeAuthors ? new Set(filters.includeAuthors.map(normalizeActor)) : undefined
  const excludeAuthors = new Set((filters.excludeAuthors ?? []).map(normalizeActor))
  const excludeLabels = new Set(filters.excludeLabels ?? [])
  const maxAgeMs = filters.maxAgeHours ? filters.maxAgeHours * 3_600_000 : undefined

  return (candidate, now) => {
    const { post } = candidate
    const author = post.author

    if (filters.excludeReposts && candidate.repost) return false
    if (maxAgeMs !== undefined && now - candidate.sortAt > maxAgeMs) return false
    if ((post.likeCount ?? 0) < filters.minLikes) return false
    if ((post.repostCount ?? 0) < filters.minReposts) return false
    if ((post.replyCount ?? 0) < filters.minReplies) return false

    const authorKeys = [author.did.toLowerCase(), author.handle.toLowerCase()]
    if (includeAuthors && !authorKeys.some((k) => includeAuthors.has(k))) return false
    if (authorKeys.some((k) => excludeAuthors.has(k))) return false

    if (excludeLabels.size) {
      const labels = [...(post.labels ?? []), ...(author.labels ?? [])]
      if (labels.some((l) => excludeLabels.has(l.val) && !l.neg)) return false
    }

    const f = featuresOf(post)
    if (filters.excludeReplies && f.isReply) return false
    if (filters.excludeQuotes && f.isQuote) return false
    if (languages && f.langs.length && !f.langs.some((l) => languages.includes(baseLanguage(l)))) return false

    switch (filters.media) {
      case 'required':
        if (!f.hasImages && !f.hasVideo) return false
        break
      case 'images':
        if (!f.hasImages) return false
        break
      case 'video':
        if (!f.hasVideo) return false
        break
      case 'none':
        if (f.hasImages || f.hasVideo) return false
        break
    }
    if (filters.links === 'required' && !f.hasLinks) return false
    if (filters.links === 'none' && f.hasLinks) return false

    if (include && !include(f.searchText, f.tags)) return false
    if (exclude && exclude(f.searchText, f.tags)) return false
    if (includeRe && !includeRe.test(f.searchText)) return false
    if (excludeRe && excludeRe.test(f.searchText)) return false

    if (custom && !custom(post, { isRepost: candidate.repost !== undefined })) return false
    return true
  }
}
