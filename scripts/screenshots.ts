/**
 * Takes the README screenshots in docs/screenshots/, light and dark, as WebP.
 *
 * Runs the real app against made-up accounts, feeds and posts, so no real
 * person's posts end up in the images and no Bluesky sign-in is needed.
 * Needs Playwright with Chromium installed (it isn't a dependency of the app):
 *
 *   npm run screenshots
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { serve } from '@hono/node-server'
import { createApp } from '../src/app.js'
import { LOGIN_COOKIE, Logins, type OwnerAuth } from '../src/auth.js'
import { FeedRestorer, makeBackup } from '../src/backup.js'
import type { Bsky } from '../src/bsky.js'
import { loadConfig } from '../src/config.js'
import { openDatabase } from '../src/db.js'
import { type FeedDefinitionInput, type FeedSource, REMEMBER_LIMIT, parseFeeds } from '../src/feeds/define.js'
import { FeedEngine } from '../src/feeds/engine.js'
import type { Candidate, PostView } from '../src/feeds/post.js'
import { CombinedRegistry } from '../src/feeds/registry.js'
import { Members } from '../src/members.js'
import catPics from '../feeds/cat-pics.js'

const HOST = 'blue-feeds.example'
const SERVICE = `did:web:${HOST}`
const ME = 'did:plc:demosam'
const MY_HANDLE = 'sam.example'
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname
/** Images the pages load are answered by the browser script below, from these made-up URLs. */
const ART = 'https://art.blue-feeds.example'

// --- Made-up people and posts ---

const PEOPLE: Record<string, { name: string; hue: number }> = {
  'juniper.example': { name: 'Juniper Hale', hue: 145 },
  'okra.example': { name: 'Okra & Thyme', hue: 95 },
  'dana.example': { name: 'Dana Whitfield', hue: 25 },
  'vesper.example': { name: 'Vesper Observatory', hue: 255 },
  'tomas.example': { name: 'Tomás Reyes', hue: 205 },
  'ilse.example': { name: 'Ilse Marr', hue: 320 },
  'pixelmoth.example': { name: 'Pixel Moth Games', hue: 280 },
  [MY_HANDLE]: { name: 'Sam', hue: 210 },
}

let n = 0
function post(handle: string, text: string, opts: { hours: number; likes: number; reposts?: number; replies?: number; image?: string }): Candidate {
  const at = new Date(Date.now() - opts.hours * 3_600_000).toISOString()
  const did = `did:plc:${handle.split('.')[0]}`
  const view: PostView = {
    uri: `at://${did}/app.bsky.feed.post/3demo${String(++n).padStart(6, '0')}`,
    cid: `bafydemo${n}`,
    author: { did, handle, displayName: PEOPLE[handle]?.name, avatar: `${ART}/avatar/${handle}.svg`, labels: [] },
    record: { $type: 'app.bsky.feed.post', text, createdAt: at, langs: ['en'] },
    ...(opts.image
      ? { embed: { $type: 'app.bsky.embed.images#view', images: [{ thumb: `${ART}/photo/${opts.image}.svg`, fullsize: '', alt: opts.image }] } }
      : {}),
    likeCount: opts.likes,
    repostCount: opts.reposts ?? Math.round(opts.likes / 6),
    replyCount: opts.replies ?? Math.round(opts.likes / 9),
    indexedAt: at,
    labels: [],
  }
  return { post: view, sortAt: Date.parse(at) }
}

const POSTS: Record<string, Candidate[]> = {
  garden: [
    post('juniper.example', 'First tomatoes of the year! Started these from seed in February and they finally came through.', { hours: 2, likes: 214, image: 'tomatoes' }),
    post('okra.example', 'Seedling update: the basil is thriving, the coriander is sulking as usual. Any tips for keeping it from bolting?', { hours: 3, likes: 88, image: 'seedlings' }),
    post('dana.example', 'Community garden plot is officially planted. Beans along the fence, squash in the corner, marigolds everywhere.', { hours: 5, likes: 131 }),
    post('juniper.example', 'Reminder that compost is just slow-motion cooking for worms.', { hours: 7, likes: 342, reposts: 61 }),
    post('okra.example', 'Raised bed number three is done. Cedar boards, no screws, held together with stubbornness.', { hours: 11, likes: 57, image: 'raised-bed' }),
  ],
  sky: [
    post('vesper.example', 'Clear skies tonight! Jupiter rises around 9pm, with three of its moons visible in binoculars.', { hours: 1, likes: 402, image: 'night-sky' }),
    post('tomas.example', 'Caught the Orionids from a field outside town. Twelve meteors in an hour, one with a long green trail.', { hours: 4, likes: 167 }),
    post('vesper.example', 'Public stargazing night this Saturday. Bring a blanket; we bring the telescopes.', { hours: 9, likes: 93 }),
  ],
  dev: [
    post('pixelmoth.example', 'Devlog #42: the lantern now casts real shadows. It took three rewrites and a lot of tea.', { hours: 2, likes: 156, image: 'lantern' }),
    post('ilse.example', 'Shipped the save system today. Your progress survives a crash now, which feels like the bare minimum but here we are.', { hours: 6, likes: 74 }),
  ],
  books: [
    post('ilse.example', 'Finished a 900-page fantasy novel in four days and now I need to lie down.', { hours: 3, likes: 128 }),
    post('dana.example', 'Our book club picked a mystery this month. Nobody has guessed the twist yet, which is a first.', { hours: 8, likes: 61 }),
  ],
}

function demoSource(source: FeedSource): Candidate[] {
  const text = JSON.stringify(source).toLowerCase()
  if (/garden|seedling|compost/.test(text)) return POSTS.garden!
  if (/astronomy|sky/.test(text)) return POSTS.sky!
  if (/pixelmoth|ilse/.test(text) || source.type === 'author') return POSTS.dev!
  if (/cat/.test(text)) return []
  return POSTS.books!
}

// --- Made-up feeds ---

const FEEDS: FeedDefinitionInput[] = [
  {
    id: 'garden-notes',
    displayName: 'Garden Notes',
    description: 'Seedlings, harvests and compost wisdom from home gardeners.',
    sources: [
      { type: 'search', query: 'garden', sort: 'latest', lang: 'en' },
      { type: 'search', query: 'seedlings', sort: 'top' },
    ],
    filters: { excludeReplies: true, includeKeywords: ['garden*', 'seedling*', 'compost', 'tomato*', 'raised bed'], maxAgeHours: 48 },
    sort: 'hot',
    remember: true,
  },
  {
    id: 'night-sky',
    displayName: 'Night Sky',
    description: "What's up tonight: planets, meteor showers and stargazing meetups.",
    sources: [{ type: 'search', query: 'astronomy', sort: 'top' }],
    filters: { media: 'any', minLikes: 5 },
    sort: 'top',
  },
  {
    id: 'indie-dev',
    displayName: 'Indie Dev Log',
    description: 'Devlogs from small game studios.',
    sources: [{ type: 'author', actors: ['pixelmoth.example', 'ilse.example'], filter: 'posts_no_replies' }],
    filters: { excludeReposts: true },
    sort: 'newest',
  },
  {
    id: 'bookish',
    displayName: 'Bookish',
    description: 'Book club chatter and reading lists.',
    sources: [{ type: 'list', list: `at://${ME}/app.bsky.graph.list/3demobooks` }],
    filters: {},
    sort: 'newest',
  },
]

/** What's published in the demo account's Bluesky repo. Night Sky's name changed since, so it shows as out of date. */
const RECORDS = new Map<string, Record<string, unknown>>([
  ['garden-notes', record('Garden Notes', FEEDS[0]!, 'garden')],
  ['night-sky', record('Night Sky Watch', FEEDS[1]!, 'sky')],
  ['bookish', record('Bookish', FEEDS[3]!, 'books')],
  [
    'cozy-games',
    {
      did: 'did:web:skyfeed.me',
      displayName: 'Cozy Games',
      createdAt: new Date().toISOString(),
      skyfeedBuilder: { displayName: 'Cozy Games', blocks: [{ type: 'input', inputType: 'firehose' }] },
    },
  ],
])

function record(displayName: string, def: FeedDefinitionInput, avatar: string): Record<string, unknown> {
  return {
    did: SERVICE,
    displayName,
    description: def.description,
    avatar: { $type: 'blob', ref: { $link: `bafkreidemo${avatar}` }, mimeType: 'image/png', size: 1 },
    createdAt: new Date().toISOString(),
    blueFeeds: makeBackup(def),
  }
}

// --- The app, with stand-ins for Bluesky ---

async function startDemo() {
  const config = loadConfig({ FEEDGEN_HOSTNAME: HOST, BSKY_IDENTIFIER: MY_HANDLE, OAUTH_PRIVATE_KEY: '{}' })
  const db = await openDatabase(':memory:')
  for (const def of FEEDS) await db.createFeed(ME, def.id, def)
  const registry = new CombinedRegistry(parseFeeds([catPics]), db, 0, undefined, async () => ME)
  const engine = new FeedEngine(registry, {
    fetchSource: async (source) => demoSource(source),
    resolvePostUri: async (uri) => uri,
    hydratePosts: async () => [],
    cacheSeconds: 60,
    staleSeconds: 600,
    memory: { load: (id) => db.rememberedPosts(id), add: (id, candidates) => db.rememberPosts(id, candidates, REMEMBER_LIMIT) },
  })
  const agent = {
    assertDid: ME,
    com: {
      atproto: {
        repo: {
          listRecords: async () => ({
            data: { records: [...RECORDS].map(([rkey, value]) => ({ uri: `at://${ME}/app.bsky.feed.generator/${rkey}`, value })) },
          }),
          getRecord: async ({ rkey }: { rkey: string }) => {
            if (!RECORDS.has(rkey)) throw new Error('RecordNotFound')
            return { data: { value: RECORDS.get(rkey) } }
          },
        },
      },
    },
  }
  const bsky = {
    hasAppPassword: false,
    ownerDid: async () => ME,
    resolveDid: async (handle: string) => (handle.replace(/^@/, '') === MY_HANDLE ? ME : handle),
    toAtUri: async (input: string) => input,
    profileOf: async (did: string) => (did === ME ? { handle: MY_HANDLE, avatar: `${ART}/avatar/${MY_HANDLE}.svg` } : undefined),
    getRecord: async () => {
      throw new Error('RecordNotFound')
    },
  } as unknown as Bsky
  const logins = new Logins(db)
  const auth = { local: false, confidential: true, redirectUri: '', repoAgent: async () => agent, appviewAgent: async () => agent }
  const app = createApp({
    config,
    engine,
    bsky,
    manage: {
      db,
      registry,
      logins,
      auth: async () => auth as unknown as OwnerAuth,
      restorer: new FeedRestorer({ bsky, db, registry }),
      members: new Members(bsky, []),
      databaseId: 'demo',
      databaseHost: 'blue-feeds-demo.turso.io',
    },
  })
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise((resolve) => server.once('listening', resolve))
  return { server, port: (server.address() as AddressInfo).port, token: await logins.create(ME) }
}

// --- Pictures for avatars, feed tiles and post photos ---

function avatarSvg(name: string): string {
  const person = PEOPLE[name.replace(/\.svg$/, '')]
  const hue = person?.hue ?? 200
  const initial = (person?.name ?? name)[0]!.toUpperCase()
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue} 75% 62%)"/><stop offset="1" stop-color="hsl(${hue + 35} 70% 48%)"/></linearGradient></defs>
    <rect width="96" height="96" fill="url(#g)"/><text x="48" y="62" font-family="system-ui,sans-serif" font-size="42" font-weight="700"
    text-anchor="middle" fill="white">${initial}</text></svg>`
}

const PHOTOS: Record<string, string> = {
  tomatoes: `<rect width="400" height="260" fill="#cfe8c4"/><circle cx="140" cy="150" r="58" fill="#e8492f"/><circle cx="250" cy="140" r="64" fill="#f0603f"/>
    <circle cx="200" cy="200" r="44" fill="#d93a24"/><path d="M130 95 l10 -18 l10 18 M240 78 l10 -18 l10 18" stroke="#3f8a3a" stroke-width="8" fill="none"/>`,
  seedlings: `<rect width="400" height="260" fill="#f3e7d3"/><rect y="170" width="400" height="90" fill="#8a5a3b"/>
    ${[70, 160, 250, 340].map((x) => `<path d="M${x} 175 v-55" stroke="#4c9a3f" stroke-width="7"/><ellipse cx="${x - 18}" cy="118" rx="22" ry="11" fill="#6cbf55"/><ellipse cx="${x + 18}" cy="110" rx="22" ry="11" fill="#5cae48"/>`).join('')}`,
  'raised-bed': `<rect width="400" height="260" fill="#d6ecf5"/><rect y="150" width="400" height="110" fill="#9bc77f"/><rect x="60" y="120" width="280" height="80" rx="6" fill="#b5763f"/>
    <rect x="70" y="112" width="260" height="22" rx="8" fill="#6b4630"/>${[100, 150, 200, 250, 300].map((x) => `<circle cx="${x}" cy="105" r="16" fill="#4fa34a"/>`).join('')}`,
  'night-sky': `<rect width="400" height="260" fill="#14193a"/>${Array.from({ length: 40 }, (_, i) => `<circle cx="${(i * 97) % 400}" cy="${(i * 53) % 200}" r="${(i % 3) + 1}" fill="#fff" opacity=".8"/>`).join('')}
    <circle cx="300" cy="80" r="26" fill="#f4d58d"/><path d="M0 230 Q 120 190 220 225 T 400 210 V 260 H 0 Z" fill="#0b0f26"/>`,
  lantern: `<rect width="400" height="260" fill="#1f1a33"/><circle cx="200" cy="130" r="110" fill="#f5b942" opacity=".18"/><circle cx="200" cy="130" r="60" fill="#f5b942" opacity=".3"/>
    <rect x="175" y="95" width="50" height="75" rx="10" fill="#f8d36b"/><rect x="170" y="85" width="60" height="12" rx="4" fill="#5b4a7a"/><path d="M200 85 v-20" stroke="#5b4a7a" stroke-width="5"/>`,
}

function photoSvg(name: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 260">${PHOTOS[name.replace(/\.svg$/, '')] ?? ''}</svg>`
}

/** Feed avatars, from the made-up blob refs in RECORDS. */
function feedAvatarSvg(cid: string): string {
  const art: Record<string, string> = {
    garden: `<rect width="96" height="96" fill="#5cb85c"/><path d="M48 78 V44" stroke="#fff" stroke-width="6"/><ellipse cx="34" cy="42" rx="16" ry="9" fill="#fff"/><ellipse cx="62" cy="36" rx="16" ry="9" fill="#e8f7e4"/>`,
    sky: `<rect width="96" height="96" fill="#2b3270"/><circle cx="60" cy="38" r="16" fill="#f4d58d"/><circle cx="24" cy="24" r="2" fill="#fff"/><circle cx="30" cy="66" r="2" fill="#fff"/><circle cx="74" cy="72" r="3" fill="#fff"/>`,
    books: `<rect width="96" height="96" fill="#e9784f"/><rect x="24" y="26" width="14" height="46" rx="2" fill="#fff"/><rect x="41" y="22" width="14" height="50" rx="2" fill="#ffe7da"/><rect x="58" y="30" width="14" height="42" rx="2" fill="#fff"/>`,
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">${art[cid.replace('bafkreidemo', '')] ?? ''}</svg>`
}

// --- Taking the pictures ---

interface Page {
  goto(url: string): Promise<unknown>
  click(selector: string): Promise<void>
  waitForSelector(selector: string): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  route(pattern: string, handler: (route: Route) => unknown): Promise<void>
  screenshot(options?: { fullPage?: boolean }): Promise<Buffer>
  evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>
}
interface Route {
  request(): { url(): string }
  fulfill(response: { contentType: string; body: string }): Promise<void>
}
interface Context {
  addCookies(cookies: { name: string; value: string; domain: string; path: string }[]): Promise<void>
  newPage(): Promise<Page>
  close(): Promise<void>
}
interface Browser {
  newContext(options: Record<string, unknown>): Promise<Context>
  close(): Promise<void>
}
const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(o: object): Promise<Browser> } }

const SHOTS: { name: string; path: string; signedIn: boolean; width: number; height: number; prepare?: (page: Page) => Promise<void> }[] = [
  { name: 'welcome', path: '/', signedIn: false, width: 1280, height: 800 },
  { name: 'dashboard', path: '/', signedIn: true, width: 1280, height: 1260 },
  {
    name: 'editor',
    path: '/feeds/garden-notes/edit',
    signedIn: true,
    width: 1280,
    height: 1000,
    prepare: async (page) => {
      await page.click('[data-preview]')
      await page.waitForSelector('.timeline .post')
    },
  },
  { name: 'phone', path: '/feeds/garden-notes', signedIn: true, width: 390, height: 844 },
]

/** WebP is a fraction of PNG's size for these pages. Chromium's canvas encodes it, so nothing else needs installing. */
async function toWebp(page: Page, png: Buffer): Promise<Buffer> {
  const dataUrl = await page.evaluate(async (base64: string) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    canvas.getContext('2d')!.drawImage(image, 0, 0)
    return canvas.toDataURL('image/webp', 0.9)
  }, png.toString('base64'))
  return Buffer.from(dataUrl.split(',')[1]!, 'base64')
}

async function main() {
  const { server, port, token } = await startDemo()
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${port}`] })
  try {
    for (const scheme of ['light', 'dark'] as const) {
      for (const shot of SHOTS) {
        const phone = shot.width < 600
        const context = await browser.newContext({
          viewport: { width: shot.width, height: shot.height },
          deviceScaleFactor: 2,
          colorScheme: scheme,
          reducedMotion: 'reduce',
          ...(phone ? { isMobile: true, hasTouch: true } : {}),
        })
        if (shot.signedIn) await context.addCookies([{ name: LOGIN_COOKIE, value: token, domain: HOST, path: '/' }])
        const page = await context.newPage()
        await page.route(`${ART}/**`, (route) => {
          const url = new URL(route.request().url())
          const [, kind, file] = url.pathname.split('/')
          const body = kind === 'avatar' ? avatarSvg(file!) : photoSvg(file!)
          return route.fulfill({ contentType: 'image/svg+xml', body })
        })
        await page.route('https://cdn.bsky.app/**', (route) => {
          const cid = route.request().url().split('/').pop()!
          return route.fulfill({ contentType: 'image/svg+xml', body: feedAvatarSvg(cid) })
        })
        await page.goto(`http://${HOST}${shot.path}`)
        await shot.prepare?.(page)
        await page.waitForTimeout(300)
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
        if (sideways) console.warn(`${shot.name} (${scheme}) scrolls sideways`)
        const file = `${OUT}${shot.name}-${scheme}.webp`
        writeFileSync(file, await toWebp(page, await page.screenshot()))
        console.log(`Saved ${file}`)
        await context.close()
      }
    }
  } finally {
    await browser.close()
    server.close()
  }
}

await main()
