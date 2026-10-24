/**
 * Creates or updates an app.bsky.feed.generator record for every feed in
 * feeds/index.ts, which is what makes the feeds show up in Bluesky.
 *
 *   npm run publish-feeds              publish all feeds
 *   npm run publish-feeds -- --dry-run show what would change
 *   npm run publish-feeds -- --prune   also delete records for feeds you removed
 *   npm run publish-feeds -- --only cat-pics
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { parseArgs } from 'node:util'
import { AtpAgent, type BlobRef } from '@atproto/api'
import { loadConfig, loadDotEnv } from '../src/config.js'
import { parseFeeds } from '../src/feeds/define.js'
import { feedUrl } from '../src/web/views.js'
import { feeds as feedInputs } from '../feeds/index.js'

const COLLECTION = 'app.bsky.feed.generator'
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }

interface GeneratorRecord {
  did: string
  displayName: string
  description?: string
  avatar?: BlobRef
  createdAt: string
}

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

const existing = new Map<string, GeneratorRecord>()
let cursor: string | undefined
do {
  const { data } = await agent.com.atproto.repo.listRecords({ repo, collection: COLLECTION, limit: 100, cursor })
  for (const record of data.records) existing.set(record.uri.split('/').pop()!, record.value as unknown as GeneratorRecord)
  cursor = data.records.length ? data.cursor : undefined
} while (cursor)

let skipped = 0
for (const feed of feeds) {
  const previous = existing.get(feed.id)
  if (previous && previous.did !== serviceDid && !args.force) {
    console.log(`! ${feed.id}: skipped, an existing feed with this id points at ${previous.did}. Re-run with --force to take it over.`)
    skipped++
    continue
  }

  let avatar: BlobRef | undefined
  if (feed.avatar) {
    const encoding = IMAGE_TYPES[extname(feed.avatar).toLowerCase()]
    if (!encoding) fail(`${feed.id}: avatar must be a .png or .jpg file`)
    const bytes = await readFile(feed.avatar).catch(() => fail(`${feed.id}: can't read avatar file ${feed.avatar}`))
    if (!dryRun) avatar = (await agent.uploadBlob(bytes, { encoding })).data.blob
  }

  const record = {
    $type: COLLECTION,
    did: serviceDid,
    displayName: feed.displayName,
    description: feed.description,
    avatar,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  }
  if (!dryRun) await agent.com.atproto.repo.putRecord({ repo, collection: COLLECTION, rkey: feed.id, record })
  console.log(`${previous ? '↻ updated' : '+ created'} ${feed.displayName.padEnd(24)} ${feedUrl(repo, feed.id)}`)
}

if (args.prune) {
  const keep = new Set(all.map((f) => f.id))
  for (const [rkey, record] of existing) {
    if (record.did !== serviceDid || keep.has(rkey)) continue
    if (!dryRun) await agent.com.atproto.repo.deleteRecord({ repo, collection: COLLECTION, rkey })
    console.log(`- deleted ${rkey}`)
  }
}

if (!config.publisherDid && config.bsky.identifier.includes('@')) {
  console.log(`\nBSKY_IDENTIFIER is an email address, so also set FEEDGEN_PUBLISHER_DID=${repo} on your deployment.`)
}
console.log(skipped ? `\nDone, ${skipped} skipped.` : '\nDone.')
