import { defineFeed } from '../src/feeds/define.js'

export default defineFeed({
  id: 'gh-projects',
  displayName: 'GitHub Projects',
  description: 'People sharing GitHub repos, with at least a sentence about what they built.',
  sources: [{ type: 'search', query: 'github', domain: 'github.com', sort: 'latest', limit: 300 }],
  filters: { links: 'required', excludeReposts: true, maxAgeHours: 72, languages: ['en'] },
  sort: 'hot',
  // Custom filters can express anything the declarative ones can't.
  filter: (post) => {
    const text = (post.record as { text?: string }).text ?? ''
    return text.replace(/https?:\/\/\S+/g, '').trim().length >= 40
  },
})
