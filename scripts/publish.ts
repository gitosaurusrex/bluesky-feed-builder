/**
 * Creates or updates an app.bsky.feed.generator record for every feed in
 * feeds/index.ts, which is what makes the feeds show up in Bluesky. Feeds made
 * in the dashboard editor are published from the dashboard instead.
 *
 *   npm run publish-feeds              publish all feeds
 *   npm run publish-feeds -- --dry-run show what would change
 *   npm run publish-feeds -- --prune   also delete records for feeds you removed
 *   npm run publish-feeds -- --only cat-pics
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { parseArgs } from 'node:util'
import { AtpAgent } from '@atproto/api'
import { feeds as feedInputs } from '../feeds/index.js'
import { loadConfig, loadDotEnv } from '../src/config.js'
import { parseFeeds } from '../src/feeds/define.js'
import { type AvatarChange, feedUrl, listGeneratorRecords, publishFeed, unpublishFeed } from '../src/publish.js'

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

loadDotEnv()
const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    prune: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    only: { type: 'string' },
  },
})
const dryRun = args['dry-run']

const config = loadConfig()
if (!config.hostname && !config.serviceDid) {
  fail('Set FEEDGEN_HOSTNAME to the public hostname of your deployment, e.g. my-feeds.vercel.app')
}
if (!config.bsky.identifier || !config.bsky.appPassword) {
  fail('Set BSKY_IDENTIFIER and BSKY_APP_PASSWORD. Create an app password at https://bsky.app/settings/app-passwords')
}
const serviceDid = config.serviceDid ?? `did:web:${config.hostname}`

const all = parseFeeds(feedInputs)
const feeds = args.only ? all.filter((f) => f.id === args.only) : all
if (args.only && !feeds.length) fail(`No feed with id "${args.only}". Known ids: ${all.map((f) => f.id).join(', ')}`)

const agent = new AtpAgent({ service: config.bsky.service })
await agent.login({ identifier: config.bsky.identifier, password: config.bsky.appPassword })
const repo = agent.assertDid
console.log(`Publishing as ${agent.session?.handle} (${repo}) for service ${serviceDid}${dryRun ? ' [dry run]' : ''}\n`)

const existing = await listGeneratorRecords(agent)

let skipped = 0
for (const feed of feeds) {
  const previous = existing.get(feed.id)
  if (previous && previous.did !== serviceDid && !args.force) {
    console.log(`! ${feed.id}: skipped, an existing feed with this id points at ${previous.did}. Re-run with --force to take it over.`)
    skipped++
    continue
  }

  // Without an avatar in the feed file, keep whatever is there, which may have been set from the dashboard.
  let avatar: AvatarChange = 'keep'
  if (feed.avatar) {
    const encoding = IMAGE_TYPES[extname(feed.avatar).toLowerCase()]
    if (!encoding) fail(`${feed.id}: avatar must be a .png or .jpg file`)
    const bytes = await readFile(feed.avatar).catch(() => fail(`${feed.id}: can't read avatar file ${feed.avatar}`))
    avatar = { bytes, encoding }
  }

  if (!dryRun) await publishFeed(agent, { feed, serviceDid, previous, avatar })
  console.log(`${previous ? '↻ updated' : '+ created'} ${feed.displayName.padEnd(24)} ${feedUrl(repo, feed.id)}`)
}

if (args.prune) {
  // Records for feeds made in the dashboard editor aren't in feeds/, so pruning needs a fresh look at the database.
  const keep = new Set(all.map((f) => f.id))
  if (config.database) {
    const { openDatabase } = await import('../src/db.js')
    const db = await openDatabase(config.database.url, config.database.authToken)
    for (const stored of await db.listFeeds()) keep.add(stored.id)
  }
  for (const [rkey, record] of existing) {
    if (record.did !== serviceDid || keep.has(rkey)) continue
    if (!dryRun) await unpublishFeed(agent, rkey)
    console.log(`- deleted ${rkey}`)
  }
}

if (!config.publisherDid && config.bsky.identifier.includes('@')) {
  console.log(`\nBSKY_IDENTIFIER is an email address, so also set FEEDGEN_PUBLISHER_DID=${repo} on your deployment.`)
}
console.log(skipped ? `\nDone, ${skipped} skipped.` : '\nDone.')
