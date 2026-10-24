import { defineFeed } from '../src/feeds/define.js'

// Works without an app password: author feeds are public.
export default defineFeed({
  id: 'bsky-team',
  displayName: 'Bluesky HQ',
  description: 'Announcements from the official Bluesky and AT Protocol accounts, without the replies.',
  sources: [{ type: 'author', actors: ['bsky.app', 'atproto.com'] }],
  filters: { excludeReplies: true },
  sort: 'newest',
})
