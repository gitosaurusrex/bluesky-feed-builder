import type { LooseFeed } from '../web/editor.js'

/** SkyFeed's builder settings, stored in its feed records as `skyfeedBuilder`. */
export interface SkyfeedBuilder {
  blocks?: Record<string, unknown>[]
  displayName?: string
}

export interface ConvertedFeed {
  feed: LooseFeed
  /** Things that work differently or couldn't be converted, for the owner to review. */
  notes: string[]
}

/** How far back an author source looks, standing in for SkyFeed's "remember" block. */
const AUTHOR_LOOKBACK = 1000

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => str(x) ?? []) : str(v) ? [str(v)!] : [])

/** All string values in a block that look like at:// URIs of the given collection. */
function urisIn(block: Record<string, unknown>, collection: string): string[] {
  return Object.values(block)
    .flatMap(strings)
    .filter((s) => s.startsWith('at://') && s.includes(`/${collection}/`))
}

/** Regex sources that must all match, combined into one pattern with lookaheads. */
function allOf(patterns: string[]): string | undefined {
  if (patterns.length <= 1) return patterns[0]
  return patterns.map((p) => `(?=[\\s\\S]*?(?:${p}))`).join('')
}

/** Patterns of which any may match. */
function anyOf(patterns: string[]): string | undefined {
  if (patterns.length <= 1) return patterns[0]
  return patterns.map((p) => `(?:${p})`).join('|')
}

/**
 * Converts SkyFeed builder settings into a Feed Builder definition. SkyFeed
 * runs blocks as a pipeline; this treats every input as a source and every
 * filter as applying to all of them, which matches how most feeds are built.
 */
export function convertSkyfeed(builder: SkyfeedBuilder): ConvertedFeed {
  const notes: string[] = []
  const sources: Record<string, unknown>[] = []
  const include: string[] = []
  const exclude: string[] = []
  const filters: Record<string, unknown> = {}
  let sort: string | undefined
  let maxPosts: number | undefined
  let remembers = false
  let seenFilter = false

  for (const block of builder.blocks ?? []) {
    const type = str(block.type)
    switch (type) {
      case 'input': {
        if (seenFilter) notes.push('An input came after a filter in SkyFeed. Here, every filter applies to every source.')
        const inputType = str(block.inputType)
        if (inputType === 'did') {
          const actors = [...strings(block.did), ...strings(block.dids)]
          if (actors.length) {
            // Every post by these accounts, replies included; reposts aren't theirs, so they're filtered out below.
            sources.push({ type: 'author', actors, filter: 'posts_with_replies', limit: AUTHOR_LOOKBACK })
            filters.excludeReposts = true
            break
          }
        } else if (inputType === 'list') {
          const [list] = urisIn(block, 'app.bsky.graph.list')
          if (list) {
            sources.push({ type: 'list', list, limit: 300 })
            break
          }
        } else if (inputType === 'feed') {
          const [feed] = urisIn(block, 'app.bsky.feed.generator')
          if (feed) {
            sources.push({ type: 'feed', feed, limit: 300 })
            break
          }
        } else if (inputType === 'post' || inputType === 'single_post') {
          const posts = urisIn(block, 'app.bsky.feed.post')
          if (posts.length) {
            sources.push({ type: 'posts', posts })
            break
          }
        } else if (inputType === 'firehose') {
          notes.push(
            "SkyFeed's whole-network input can't be converted, because Feed Builder doesn't read the full firehose. Add a search source with the words your filters look for instead.",
          )
          break
        }
        notes.push(`Skipped an input Feed Builder can't convert (${inputType ?? 'unknown type'}).`)
        break
      }
      case 'regex': {
        seenFilter = true
        const value = str(block.value)
        if (!value) break
        ;(block.invert === true ? exclude : include).push(value)
        if (block.caseSensitive === true) notes.push(`The regex "${value}" was case-sensitive in SkyFeed; here it ignores case.`)
        const target = str(block.target)
        if (target && target !== 'text') {
          notes.push(`The regex "${value}" checked "${target}" in SkyFeed; here it checks post text, image descriptions and link previews.`)
        }
        break
      }
      case 'remove': {
        seenFilter = true
        const subject = str(block.subject) ?? str(block.value) ?? ''
        if (/repl/.test(subject)) filters.excludeReplies = true
        else if (/repost/.test(subject)) filters.excludeReposts = true
        else if (/quote/.test(subject)) filters.excludeQuotes = true
        else notes.push(`Skipped a "remove" filter Feed Builder can't convert${subject ? ` (${subject})` : ''}.`)
        break
      }
      case 'sort': {
        const sortType = str(block.sortType)
        if (sortType === 'created_at') sort = 'newest'
        else if (sortType === 'likes' || sortType === 'reposts') sort = 'top'
        else if (sortType === 'hn') sort = 'hot'
        else notes.push(`SkyFeed's "${sortType ?? 'unknown'}" order isn't available; using newest first.`)
        break
      }
      case 'limit': {
        const count = Number(block.count ?? block.value)
        if (Number.isFinite(count) && count > 0) maxPosts = Math.min(2000, Math.round(count))
        break
      }
      case 'remember':
        remembers = true
        break
      default:
        notes.push(`Skipped a "${type ?? 'unknown'}" block Feed Builder can't convert.`)
    }
  }

  if (remembers) {
    notes.push(
      `SkyFeed's "remember" block kept every match forever. As imported, this feed looks through each account's latest ${AUTHOR_LOOKBACK.toLocaleString('en-US')} posts, so older matches drop off. Tick "Remember posts" to keep them.`,
    )
  }
  if (!sources.length) notes.push('No sources could be converted. Add at least one before saving.')

  const includeRegex = allOf(include)
  const excludeRegex = anyOf(exclude)
  return {
    feed: {
      displayName: str(builder.displayName)?.slice(0, 24),
      sources: sources.length ? sources : [{ type: 'search' }],
      filters: {
        ...filters,
        ...(includeRegex ? { includeRegex } : {}),
        ...(excludeRegex ? { excludeRegex } : {}),
      },
      sort: sort ?? 'newest',
      ...(maxPosts ? { maxPosts } : {}),
    },
    notes,
  }
}

export type ImportInput =
  | { kind: 'link'; uri: string }
  | { kind: 'skyfeed'; builder: SkyfeedBuilder; record?: { displayName?: string; description?: string } }
  | { kind: 'feed'; feed: LooseFeed }

/**
 * Works out what was pasted: a feed link, a SkyFeed export (the builder
 * settings or the whole feed record), or a Feed Builder definition.
 */
export function parseImport(text: string): ImportInput {
  const value = text.trim()
  if (/^(at:\/\/|https?:\/\/)/.test(value) && !/\s/.test(value)) return { kind: 'link', uri: value }

  let json: unknown
  try {
    json = JSON.parse(value)
  } catch {
    throw new Error("That isn't a feed link or valid JSON.")
  }
  if (!json || typeof json !== 'object') throw new Error("That JSON isn't a feed.")
  // getRecord responses wrap the record in `value`.
  const obj = ('value' in json && json.value && typeof json.value === 'object' ? json.value : json) as Record<string, unknown>

  if (obj.skyfeedBuilder && typeof obj.skyfeedBuilder === 'object') {
    return {
      kind: 'skyfeed',
      builder: obj.skyfeedBuilder as SkyfeedBuilder,
      record: { displayName: str(obj.displayName), description: str(obj.description) },
    }
  }
  if (Array.isArray(obj.blocks)) return { kind: 'skyfeed', builder: obj as SkyfeedBuilder }
  if (Array.isArray(obj.sources)) return { kind: 'feed', feed: obj }
  throw new Error("That JSON doesn't look like a SkyFeed or Feed Builder feed.")
}
