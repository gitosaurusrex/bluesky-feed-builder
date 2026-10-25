import type { Agent, BlobRef } from '@atproto/api'
import type { Bsky } from './bsky.js'
import type { FeedDefinition } from './feeds/define.js'
import type { DashboardFeed } from './web/views.js'

/** The record type that makes a feed appear in Bluesky. One per feed, in the publisher's repo. */
export const FEED_COLLECTION = 'app.bsky.feed.generator'

export interface GeneratorRecord {
  /** SkyFeed keeps its builder settings here. */
  skyfeedBuilder?: unknown
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

/**
 * Published feeds as Bluesky's public AppView lists them. Needs no sign-in, so
 * it works for any visitor, but only includes feeds the AppView has indexed.
 */
export async function listPublicGenerators(agent: Agent, did: string): Promise<Map<string, GeneratorRecord & { avatarUrl?: string }>> {
  const records = new Map<string, GeneratorRecord & { avatarUrl?: string }>()
  let cursor: string | undefined
  do {
    const { data } = await agent.app.bsky.feed.getActorFeeds({ actor: did, limit: 100, cursor })
    for (const f of data.feeds) {
      records.set(f.uri.split('/').pop()!, {
        did: f.did,
        displayName: f.displayName,
        description: f.description,
        createdAt: f.indexedAt,
        avatarUrl: f.avatar,
      })
    }
    cursor = data.feeds.length ? data.cursor : undefined
  } while (cursor)
  return records
}

export function publishStatus(feed: FeedDefinition, record: GeneratorRecord | undefined, serviceDid: string): PublishStatus {
  if (!record) return 'unpublished'
  if (record.did !== serviceDid) return 'elsewhere'
  const same = record.displayName === feed.displayName && (record.description ?? '') === (feed.description ?? '')
  return same ? 'published' : 'outdated'
}

/** Where Bluesky's CDN serves a feed's avatar, from the blob in its record. */
export function avatarUrl(did: string, avatar: unknown): string | undefined {
  const ref = (avatar as { ref?: unknown } | undefined)?.ref
  // Records read through the API hold a CID object; raw JSON holds { $link }.
  const cid = ref && typeof ref === 'object' && '$link' in ref ? String((ref as { $link: unknown }).$link) : ref ? String(ref) : ''
  return /^[a-z0-9]+$/i.test(cid) ? `https://cdn.bsky.app/img/avatar/plain/${did}/${cid}` : undefined
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

  // Keep fields other apps stored in the record, such as SkyFeed's settings, so moving a feed here can be undone.
  const { description: _description, avatar: _avatar, ...kept } = (previous ?? {}) as Partial<GeneratorRecord>
  const record: GeneratorRecord = {
    ...kept,
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

/** Fills in each feed's publish status from the public AppView. On failure, statuses stay unknown. */
export async function withPublicStatus(
  bsky: Bsky,
  feeds: DashboardFeed[],
  publisherDid: string | undefined,
  serviceDid: string,
): Promise<DashboardFeed[]> {
  if (!publisherDid) return feeds
  try {
    const records = await listPublicGenerators(bsky.public, publisherDid)
    return feeds.map((f) => {
      const record = records.get(f.def.id)
      return { ...f, status: publishStatus(f.def, record, serviceDid), avatar: record?.avatarUrl }
    })
  } catch (err) {
    console.error('Loading published feeds from the AppView failed:', err)
    return feeds
  }
}
