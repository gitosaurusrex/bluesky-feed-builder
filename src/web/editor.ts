import { html, raw } from 'hono/html'
import { type Html, type Viewer, layout, notice } from './layout.js'

/**
 * The editor works on loosely typed definitions, because it has to redisplay
 * whatever was submitted, including invalid values, so they can be fixed.
 */
export type LooseFeed = Record<string, unknown>
type Loose = Record<string, unknown>

type FormLike = { get(name: string): FormDataEntryValue | null; keys(): IterableIterator<string> | Iterable<string> }

const SOURCE_TYPES = ['search', 'author', 'list', 'feed', 'likes', 'posts'] as const

// Parsing helpers: empty fields mean "use the default", so they become undefined.
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const list = (v: unknown, separator = /[\n,]+/) => {
  const items = typeof v === 'string' ? v.split(separator).map((s) => s.trim()).filter(Boolean) : []
  return items.length ? items : undefined
}
const words = (v: unknown) => list(v, /[\s,]+/)
const num = (v: unknown) => (typeof v === 'string' && v.trim() ? Number(v.trim()) : undefined)
const checked = (v: unknown) => v === 'on' || v === 'true'
const omitUndefined = <T extends Loose>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

function sourceFromForm(get: (field: string) => unknown): Loose {
  const type = text(get('type')) ?? 'search'
  const limit = num(get('limit'))
  switch (type) {
    case 'search':
      return omitUndefined({
        type,
        query: text(get('target')),
        sort: text(get('sort')),
        lang: text(get('lang')),
        author: text(get('author')),
        domain: text(get('domain')),
        tags: words(get('tags'))?.map((t) => t.replace(/^#/, '')),
        limit,
      })
    case 'author':
      return omitUndefined({ type, actors: words(get('target')), filter: text(get('filter')), limit })
    case 'list':
      return omitUndefined({ type, list: text(get('target')), limit })
    case 'feed':
      return omitUndefined({ type, feed: text(get('target')), limit })
    case 'likes':
      return omitUndefined({ type, limit })
    default:
      return omitUndefined({ type, posts: words(get('target')) })
  }
}

/** Turns the editor's form fields into a feed definition, ready for validation. */
export function formToDefinition(form: FormLike): LooseFeed {
  const get = (name: string) => form.get(name) ?? undefined
  const indexes = [...new Set([...form.keys()].flatMap((k) => k.match(/^s\.(\d+)\.type$/)?.[1] ?? []))]
    .map(Number)
    .sort((a, b) => a - b)

  return omitUndefined({
    id: text(get('id')),
    displayName: text(get('displayName')),
    description: text(get('description')),
    sort: text(get('sort')),
    sources: indexes.map((i) => sourceFromForm((field) => get(`s.${i}.${field}`))),
    filters: omitUndefined({
      includeKeywords: list(get('f.includeKeywords')),
      excludeKeywords: list(get('f.excludeKeywords')),
      includeRegex: text(get('f.includeRegex')),
      excludeRegex: text(get('f.excludeRegex')),
      languages: words(get('f.languages')),
      media: text(get('f.media')),
      links: text(get('f.links')),
      excludeReplies: checked(get('f.excludeReplies')) || undefined,
      excludeReposts: checked(get('f.excludeReposts')) || undefined,
      excludeQuotes: checked(get('f.excludeQuotes')) || undefined,
      minLikes: num(get('f.minLikes')),
      minReposts: num(get('f.minReposts')),
      minReplies: num(get('f.minReplies')),
      maxAgeHours: num(get('f.maxAgeHours')),
      includeAuthors: words(get('f.includeAuthors')),
      excludeAuthors: words(get('f.excludeAuthors')),
      excludeLabels: words(get('f.excludeLabels')),
    }),
    pinned: words(get('pinned')),
    maxPosts: num(get('maxPosts')),
    cacheSeconds: num(get('cacheSeconds')),
  })
}

// Rendering helpers: show whatever is there, valid or not.
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v))
const joined = (v: unknown, separator = '\n') => (Array.isArray(v) ? v.join(separator) : str(v))
const selected = (current: unknown, value: string, fallback?: string) => ((current ?? fallback) === value ? 'selected' : '')

function select(name: string, current: unknown, options: [string, string][], fallback: string): Html {
  return html`<select name="${name}">
    ${options.map(([value, label]) => html`<option value="${value}" ${selected(current, value, fallback)}>${label}</option>`)}
  </select>`
}

const TYPE_LABELS: Record<(typeof SOURCE_TYPES)[number], string> = {
  search: 'Search',
  author: 'Posts by accounts',
  list: 'Posts by list members',
  feed: 'Another feed',
  likes: 'Your likes',
  posts: 'Hand-picked posts',
}

const TARGETS: Record<string, { label: string; placeholder: string }> = {
  search: { label: 'Search for', placeholder: 'cats OR kittens -dog' },
  author: { label: 'Accounts', placeholder: 'alice.bsky.social bob.bsky.social' },
  list: { label: 'List link', placeholder: 'https://bsky.app/profile/you.bsky.social/lists/…' },
  feed: { label: 'Feed link', placeholder: 'https://bsky.app/profile/bsky.app/feed/whats-hot' },
  posts: { label: 'Post links, one per line', placeholder: 'https://bsky.app/profile/…/post/…' },
}

function targetOf(source: Loose): string {
  switch (source.type) {
    case 'author':
      return joined(source.actors)
    case 'list':
      return str(source.list)
    case 'feed':
      return str(source.feed)
    case 'posts':
      return joined(source.posts)
    default:
      return str(source.query)
  }
}

/** One source in the editor. Fields for other source types stay in the markup and are hidden with CSS. */
function sourceRow(source: Loose, i: number | '__i__'): Html {
  const type = str(source.type) || 'search'
  const name = (field: string) => `s.${i}.${field}`
  return html`<div class="card source" data-type="${type}">
    <div class="row">
      <select name="${name('type')}" aria-label="Source type">
        ${SOURCE_TYPES.map((t) => html`<option value="${t}" ${selected(type, t)}>${TYPE_LABELS[t]}</option>`)}
      </select>
      <button type="button" class="link remove-source">Remove</button>
    </div>
    <div class="opt" data-for="search author list feed posts">
      <label>
        ${Object.entries(TARGETS).map(([t, { label }]) => html`<span class="opt" data-for="${t}">${label}</span>`)}
      </label>
      <textarea name="${name('target')}" rows="2" placeholder="${TARGETS[type]?.placeholder ?? ''}">${targetOf(source)}</textarea>
      <p class="hint opt" data-for="search">Quotes match a phrase, a minus sign excludes a word, OR matches either.</p>
      <p class="hint opt" data-for="list feed posts">Paste the link from the Bluesky app's share menu.</p>
    </div>
    <p class="hint opt" data-for="likes">Posts you've liked, newest like first.</p>
    <div class="grid">
      <div class="opt" data-for="search">
        <label>Order</label>
        ${select(name('sort'), source.sort, [['latest', 'Latest'], ['top', 'Top']], 'latest')}
      </div>
      <div class="opt" data-for="search">
        <label>Language</label><input name="${name('lang')}" value="${str(source.lang)}" placeholder="en" />
      </div>
      <div class="opt" data-for="search">
        <label>Only from account</label><input name="${name('author')}" value="${str(source.author)}" placeholder="alice.bsky.social" />
      </div>
      <div class="opt" data-for="search">
        <label>Linking to site</label><input name="${name('domain')}" value="${str(source.domain)}" placeholder="github.com" />
      </div>
      <div class="opt" data-for="search">
        <label>With all hashtags</label><input name="${name('tags')}" value="${joined(source.tags, ' ')}" placeholder="caturday" />
      </div>
      <div class="opt" data-for="author">
        <label>Include</label>
        ${select(
          name('filter'),
          source.filter,
          [
            ['posts_and_author_threads', 'Posts, reposts and self-threads'],
            ['posts_no_replies', 'Posts and reposts'],
            ['posts_with_replies', 'Everything, including replies'],
            ['posts_with_media', 'Only posts with media'],
            ['posts_with_video', 'Only posts with video'],
          ],
          'posts_and_author_threads',
        )}
      </div>
      <div class="opt" data-for="search author list feed likes">
        <label>How many to fetch</label>
        <input name="${name('limit')}" type="number" min="1" max="1000" value="${str(source.limit)}" placeholder="${type === 'author' ? '50 each' : '100'}" />
      </div>
    </div>
  </div>`
}

// Show each element only for the source types listed in its data-for.
const SOURCE_CSS = [
  '.source .opt { display:none; }',
  ...SOURCE_TYPES.flatMap((t) => [
    `.source[data-type="${t}"] div.opt[data-for~="${t}"], .source[data-type="${t}"] p.opt[data-for~="${t}"] { display:block; }`,
    `.source[data-type="${t}"] span.opt[data-for~="${t}"] { display:inline; }`,
  ]),
  '.source .grid { margin-top:4px; }',
  '#sources { margin-bottom:8px; }',
].join('\n')

const EDITOR_JS = `
const form = document.getElementById('editor');
const sources = document.getElementById('sources');
const template = document.getElementById('source-template');
const placeholders = ${JSON.stringify(Object.fromEntries(Object.entries(TARGETS).map(([t, v]) => [t, v.placeholder])))};
let next = Number(sources.dataset.next);
sources.addEventListener('change', (e) => {
  if (!e.target.matches('select[name$=".type"]')) return;
  const row = e.target.closest('.source');
  row.dataset.type = e.target.value;
  row.querySelector('textarea').placeholder = placeholders[e.target.value] || '';
});
sources.addEventListener('click', (e) => {
  if (e.target.matches('.remove-source')) e.target.closest('.source').remove();
});
document.getElementById('add-source').addEventListener('click', () => {
  sources.insertAdjacentHTML('beforeend', template.innerHTML.replaceAll('__i__', String(next++)));
});
const name = form.elements.displayName, id = form.elements.id;
if (!id.readOnly) {
  let touched = Boolean(id.value);
  id.addEventListener('input', () => { touched = true; });
  name.addEventListener('input', () => {
    if (touched) return;
    id.value = name.value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 15).replace(/-+$/, '');
  });
}
const preview = document.getElementById('preview'), results = document.getElementById('results');
preview.addEventListener('click', async () => {
  preview.disabled = true; preview.textContent = 'Loading…';
  try {
    const res = await fetch('/api/preview?format=html', { method: 'POST', body: new FormData(form) });
    results.innerHTML = await res.text();
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    results.textContent = String(err);
  } finally {
    preview.disabled = false; preview.textContent = 'Preview';
  }
});
`

export const NEW_FEED: LooseFeed = {
  sources: [{ type: 'search' }],
  filters: { excludeReplies: true, maxAgeHours: 72, excludeLabels: ['porn', 'sexual', 'nudity', 'graphic-media'] },
  sort: 'newest',
}

export function editorPage(opts: {
  viewer: Viewer
  mode: 'new' | 'edit'
  feed: LooseFeed
  error?: string
  /** What an import changed or couldn't convert, shown above the form. */
  notes?: string[]
}): Html {
  const feed = opts.feed
  const filters = (feed.filters ?? {}) as Loose
  const sources = (Array.isArray(feed.sources) ? feed.sources : []) as Loose[]
  const action = opts.mode === 'new' ? '/feeds/new' : `/feeds/${str(feed.id)}/edit`
  const title = opts.mode === 'new' ? 'New feed' : `Edit ${str(feed.displayName) || str(feed.id)}`
  const box = (name: string, label: string) =>
    html`<label class="check"><input type="checkbox" name="f.${name}" ${filters[name] ? 'checked' : ''} />${label}</label>`

  return layout(
    `${title} · Feed Builder`,
    html`<style>${raw(SOURCE_CSS)}</style>
      <h1>${title}</h1>
      ${opts.error ? notice(opts.error, 'error') : ''}
      ${opts.notes?.length
        ? notice(html`<strong>Imported. Review before saving:</strong><ul style="margin:6px 0 0; padding-left:20px">
            ${opts.notes.map((n) => html`<li>${n}</li>`)}
          </ul>`)
        : ''}
      <form id="editor" method="post" action="${action}">
        <fieldset>
          <legend>Feed</legend>
          <label for="displayName">Name</label>
          <input id="displayName" name="displayName" maxlength="24" required value="${str(feed.displayName)}" placeholder="Cat Pics" />
          <label for="id">Id</label>
          <input id="id" name="id" maxlength="15" required pattern="[a-z0-9][a-z0-9\\-]{0,14}" value="${str(feed.id)}"
            ${opts.mode === 'edit' ? 'readonly' : ''} placeholder="cat-pics" />
          <p class="hint">
            ${opts.mode === 'edit'
              ? "Part of the feed's link, so it can't change."
              : "Part of the feed's link: lowercase letters, digits and dashes. It can't change later."}
          </p>
          <label for="description">Description</label>
          <textarea id="description" name="description" maxlength="300" rows="2">${str(feed.description)}</textarea>
          <label for="sort">Order</label>
          ${select(
            'sort',
            feed.sort,
            [
              ['newest', 'Newest first'],
              ['hot', 'Hot: popular and recent'],
              ['top', 'Top: most likes and reposts'],
            ],
            'newest',
          )}
        </fieldset>

        <fieldset>
          <legend>Sources</legend>
          <p class="hint">Where posts come from. Posts from every source are combined and duplicates removed.</p>
          <div id="sources" data-next="${sources.length}">${sources.map((s, i) => sourceRow(s, i))}</div>
          <button type="button" class="secondary" id="add-source">Add source</button>
          <template id="source-template">${sourceRow({ type: 'search' }, '__i__')}</template>
        </fieldset>

        <fieldset>
          <legend>Filters</legend>
          <label>Must mention one of</label>
          <textarea name="f.includeKeywords" rows="2" placeholder="cat*, kitten*, #caturday">${joined(filters.includeKeywords)}</textarea>
          <p class="hint">One per line or comma-separated. Whole words; <code>cat*</code> matches “cats”, <code>#tag</code> matches hashtags.</p>
          <label>Must not mention</label>
          <textarea name="f.excludeKeywords" rows="2" placeholder="catalog, category">${joined(filters.excludeKeywords)}</textarea>
          <div class="grid">
            <div><label>Media</label>${select(
              'f.media',
              filters.media,
              [
                ['any', 'Any'],
                ['required', 'Images or video'],
                ['images', 'Images'],
                ['video', 'Video'],
                ['none', 'No media'],
              ],
              'any',
            )}</div>
            <div><label>Links</label>${select(
              'f.links',
              filters.links,
              [
                ['any', 'Any'],
                ['required', 'Must have a link'],
                ['none', 'No links'],
              ],
              'any',
            )}</div>
            <div><label>Languages</label><input name="f.languages" value="${joined(filters.languages, ', ')}" placeholder="en, es" /></div>
            <div><label>Max age (hours)</label><input name="f.maxAgeHours" type="number" min="1" step="any" value="${str(filters.maxAgeHours)}" /></div>
            <div><label>Min likes</label><input name="f.minLikes" type="number" min="0" value="${str(filters.minLikes)}" /></div>
            <div><label>Min reposts</label><input name="f.minReposts" type="number" min="0" value="${str(filters.minReposts)}" /></div>
            <div><label>Min replies</label><input name="f.minReplies" type="number" min="0" value="${str(filters.minReplies)}" /></div>
          </div>
          ${box('excludeReplies', 'Hide replies')} ${box('excludeReposts', 'Hide reposts')} ${box('excludeQuotes', 'Hide quote posts')}
          <label>Only these accounts</label>
          <input name="f.includeAuthors" value="${joined(filters.includeAuthors, ' ')}" placeholder="Leave empty for everyone" />
          <label>Hide these accounts</label>
          <input name="f.excludeAuthors" value="${joined(filters.excludeAuthors, ' ')}" placeholder="spammer.bsky.social" />
          <label>Hide posts labeled</label>
          <input name="f.excludeLabels" value="${joined(filters.excludeLabels, ' ')}" placeholder="porn sexual nudity graphic-media" />
        </fieldset>

        <details class="card">
          <summary><strong>Advanced</strong></summary>
          <label>Pinned posts</label>
          <textarea name="pinned" rows="2" placeholder="https://bsky.app/profile/…/post/…">${joined(feed.pinned)}</textarea>
          <p class="hint">Shown at the top of the feed, up to 10.</p>
          <label>Must match regular expression</label>
          <input name="f.includeRegex" value="${str(filters.includeRegex)}" />
          <label>Must not match regular expression</label>
          <input name="f.excludeRegex" value="${str(filters.excludeRegex)}" />
          <div class="grid">
            <div><label>Max posts</label><input name="maxPosts" type="number" min="1" max="2000" value="${str(feed.maxPosts)}" placeholder="500" /></div>
            <div><label>Cache (seconds)</label><input name="cacheSeconds" type="number" min="0" value="${str(feed.cacheSeconds)}" placeholder="60" /></div>
          </div>
        </details>

        <div class="actions">
          <button type="submit">${opts.mode === 'new' ? 'Create feed' : 'Save changes'}</button>
          <button type="button" class="secondary" id="preview">Preview</button>
          <a class="button secondary" href="/">Cancel</a>
        </div>
      </form>
      ${opts.mode === 'edit'
        ? html`<form method="post" action="/feeds/${str(feed.id)}/delete" onsubmit="return confirm('Delete this feed? If it is published, it is removed from Bluesky too.')">
            <p><button class="danger" type="submit">Delete feed</button></p>
          </form>`
        : ''}
      <div id="results"></div>
      <script>${raw(EDITOR_JS)}</script>`,
    opts.viewer,
  )
}
