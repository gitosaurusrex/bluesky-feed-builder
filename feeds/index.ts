import type { FeedDefinitionInput } from '../src/feeds/define.js'
import bskyTeam from './bsky-team.js'
import catPics from './cat-pics.js'
import ghProjects from './gh-projects.js'

/**
 * Every feed this service serves. Add a file next to this one, list it here,
 * then run `npm run publish-feeds` to make it appear in Bluesky.
 */
export const feeds: FeedDefinitionInput[] = [bskyTeam, catPics, ghProjects]
