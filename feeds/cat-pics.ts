import { defineFeed } from '../src/feeds/define.js'

// Search sources need BSKY_IDENTIFIER and BSKY_APP_PASSWORD.
export default defineFeed({
  id: 'cat-pics',
  displayName: 'Cat Pics',
  description: 'Popular cat photos from the last two days.',
  sources: [
    { type: 'search', query: 'cat', sort: 'top', limit: 200 },
    { type: 'search', query: '#caturday', sort: 'latest' },
  ],
  filters: {
    includeKeywords: ['cat*', 'kitten*', 'kitty', '#caturday'],
    excludeKeywords: ['catalog', 'category', 'caterpillar', 'catch*'],
    media: 'images',
    excludeReplies: true,
    maxAgeHours: 48,
    excludeLabels: ['porn', 'sexual', 'nudity', 'graphic-media'],
  },
  sort: 'hot',
})
