import type { FeedDefinition } from './define.js'
import { type Candidate, engagementOf } from './post.js'

/** Newest first; ties broken by URI so the order (and therefore cursors) is deterministic. */
export function compareNewest(a: Candidate, b: Candidate): number {
  if (a.sortAt !== b.sortAt) return b.sortAt - a.sortAt
  return a.post.uri < b.post.uri ? 1 : a.post.uri > b.post.uri ? -1 : 0
}

/** Engagement decayed by age, in the spirit of Hacker News: newer posts need fewer likes to rank. */
export function hotScore(candidate: Candidate, now: number): number {
  const ageHours = Math.max(0, now - candidate.sortAt) / 3_600_000
  return (engagementOf(candidate.post) + 1) / Math.pow(ageHours + 2, 1.8)
}

export function rank(candidates: Candidate[], sort: FeedDefinition['sort'], now: number): Candidate[] {
  const sorted = [...candidates]
  switch (sort) {
    case 'newest':
      return sorted.sort(compareNewest)
    case 'top':
      return sorted.sort((a, b) => engagementOf(b.post) - engagementOf(a.post) || compareNewest(a, b))
    case 'hot': {
      const scores = new Map(sorted.map((c) => [c, hotScore(c, now)]))
      return sorted.sort((a, b) => scores.get(b)! - scores.get(a)! || compareNewest(a, b))
    }
  }
}
