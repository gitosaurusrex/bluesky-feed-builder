import type { Agent, BlobRef } from '@atproto/api'
import type { FeedDefinition } from './feeds/define.js'

/** The record type that makes a feed appear in Bluesky. One per feed, in the publisher's repo. */
export const FEED_COLLECTION = 'app.bsky.feed.generator'

export interface GeneratorRecord {
  did: string
  displayName: string
  description?: string
  avatar?: BlobRef
  createdAt: string
}

export type PublishStatus = 'published' | 'outdated' | 'elsewhere' | 'unpublished'

export const feedUrl = (publisherDid: string, id: string) => `https://bsky.app/profile/${publisherDid}/feed/${id}`

/** Every feed generator record in the agent's repo, keyed by feed id. */
export async function listGeneratorRecords(agent: Agent): Promise<Map<string, GeneratorRecord>> {
  const records = new Map<string, GeneratorRecord>()
  let cursor: string | undefined
  do {
    const { data } = await agent.com.atproto.repo.listRecords({ repo: agent.assertDid, collection: FEED_COLLECTION, limit: 100, cursor })
    for (const r of data.records) records.set(r.uri.split('/').pop()!, r.value as unknown as GeneratorRecord)
    cursor = data.records.length ? data.cursor : undefined
  } while (cursor)
  return records
}

export function publishStatus(feed: FeedDefinition, record: GeneratorRecord | undefined, serviceDid: string): PublishStatus {
  if (!record) return 'unpublished'
  if (record.did !== serviceDid) return 'elsewhere'
  const same = record.displayName === feed.displayName && (record.description ?? '') === (feed.description ?? '')
  return same ? 'published' : 'outdated'
}

export type AvatarChange = { bytes: Uint8Array; encoding: string } | 'keep' | 'remove'

/** Creates or updates a feed's record. Keeps the original createdAt so Bluesky sees an edit, not a new feed. */
export async function publishFeed(
  agent: Agent,
  { feed, serviceDid, previous, avatar }: { feed: FeedDefinition; serviceDid: string; previous?: GeneratorRecord; avatar: AvatarChange },
): Promise<GeneratorRecord> {
  let avatarRef: BlobRef | undefined
  if (avatar === 'keep') avatarRef = previous?.avatar
  else if (avatar !== 'remove') avatarRef = (await agent.uploadBlob(avatar.bytes, { encoding: avatar.encoding })).data.blob

  const record: GeneratorRecord = {
    did: serviceDid,
    displayName: feed.displayName,
    ...(feed.description ? { description: feed.description } : {}),
    ...(avatarRef ? { avatar: avatarRef } : {}),
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  }
  await agent.com.atproto.repo.putRecord({
    repo: agent.assertDid,
    collection: FEED_COLLECTION,
    rkey: feed.id,
    record: { $type: FEED_COLLECTION, ...record },
  })
  return record
}

export async function unpublishFeed(agent: Agent, id: string): Promise<void> {
  await agent.com.atproto.repo.deleteRecord({ repo: agent.assertDid, collection: FEED_COLLECTION, rkey: id })
}
