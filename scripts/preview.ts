/**
 * Prints a feed's current posts to the terminal, without starting a server.
 *
 *   npm run preview             list feeds
 *   npm run preview -- cat-pics show the first 20 posts of a feed
 */
import { loadDotEnv } from '../src/config.js'

loadDotEnv()
const { createInstance } = await import('../src/instance.js')
const { engine } = await createInstance()
const feeds = await engine.feeds()
const id = process.argv[2]

if (!id) {
  for (const feed of feeds) console.log(`${feed.id.padEnd(16)} ${feed.displayName}`)
  console.log('\nRun `npm run preview -- <id>` to see a feed.')
  process.exit(0)
}
if (!feeds.some((f) => f.id === id)) {
  console.error(`No feed with id "${id}". Known ids: ${feeds.map((f) => f.id).join(', ')}`)
  process.exit(1)
}

const started = Date.now()
const { pinned, items, errors } = await engine.preview(id, 20).catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
const oneLine = (text: string) => text.replace(/\s+/g, ' ').slice(0, 100)
const age = (ms: number) => {
  const h = (Date.now() - ms) / 3_600_000
  return h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`
}

for (const error of errors) console.log(`! ${error}`)
for (const post of pinned) console.log(`📌 @${post.author.handle}  ${oneLine((post.record as { text?: string }).text ?? '')}`)
for (const { post, repost, sortAt } of items) {
  const text = oneLine((post.record as { text?: string }).text ?? '')
  const via = repost ? ` (reposted by @${repost.by.handle})` : ''
  console.log(`♥${String(post.likeCount ?? 0).padEnd(5)} ${age(sortAt).padStart(4)}  @${post.author.handle}${via}  ${text}`)
}
console.log(`\nShowing ${items.length} posts, fetched in ${Date.now() - started}ms`)
