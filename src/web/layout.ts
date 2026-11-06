import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>

/** Who is looking at the page, which decides the navigation and which actions are offered. */
export interface Viewer {
  signedIn: boolean
  /** Sign-in is available (a database is configured). */
  canSignIn: boolean
  /** The signed-in account's handle and avatar, when Bluesky could tell us. */
  handle?: string
  avatar?: string
}

export const anonymous: Viewer = { signedIn: false, canSignIn: false }

export const SITE_NAME = 'Blue Feeds'

/** The mark: a tile of feed rows, shortening like a timeline fading into the sky. */
export const MARK = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="currentColor"/><g fill="#fff"><rect x="7" y="8.5" width="18" height="3.4" rx="1.7"/><rect x="7" y="14.3" width="13" height="3.4" rx="1.7" opacity=".8"/><rect x="7" y="20.1" width="8" height="3.4" rx="1.7" opacity=".6"/></g></svg>`

export const FAVICON = MARK.replace('fill="currentColor"', 'fill="#1a6cf0"').replace('aria-hidden="true"', 'xmlns="http://www.w3.org/2000/svg"')

const FONTS =
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=Figtree:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap'

const STYLE = `
/* Layout: an app shell. A slim top bar over one 920px column; the editor splits into form + sticky live preview on wide screens. */
:root {
  --ground: #f4f7fb;      /* page: a pale, cool sky */
  --surface: #ffffff;     /* raised panels and timelines */
  --sunken: #edf2f8;      /* inputs, code, quiet fills */
  --ink: #0e1a2b;         /* text: deep navy, never pure black */
  --ink-soft: #4b5b71;    /* secondary text */
  --line: #d9e2ed;        /* hairlines */
  --blue: #1a6cf0;        /* the accent */
  --blue-strong: #0d55cc; /* links, hover */
  --blue-wash: #e5eeff;   /* tinted fills */
  --on-blue: #ffffff;
  --live: #0b7f57; --live-wash: #ddf4ea;
  --warn: #8a5300; --warn-wash: #fdefd3;
  --danger: #b8322a; --danger-wash: #fce6e3;
  --shadow: 0 1px 2px rgb(14 26 43 / 5%), 0 14px 34px -14px rgb(26 108 240 / 26%);
  --font-display: "Bricolage Grotesque", "Avenir Next", "Segoe UI", system-ui, sans-serif;
  --font-body: "Figtree", "Segoe UI", system-ui, -apple-system, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --coral: #ff7a59; --mint: #20b486; --sun: #ffb020; --violet: #8b5cf6;
  --grad: linear-gradient(135deg, var(--blue) 0%, color-mix(in srgb, var(--blue) 45%, var(--violet)) 100%);
  --sky-top: #cfe1ff; --sky-mid: #eaf2ff; --sky-low: #fff4ea;
  --cloud: #ffffff; --cloud-opacity: .85; --spark: #ffb020; --spark-2: #5c9dff;
  --radius: 18px;
  --radius-sm: 11px;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #0a111d; --surface: #111b2b; --sunken: #0d1624; --ink: #e5ecf6; --ink-soft: #95a5bc; --line: #22314a;
    --blue: #5c9dff; --blue-strong: #8dbbff; --blue-wash: #13284c; --on-blue: #04122b;
    --live: #45c690; --live-wash: #0e2d22; --warn: #f1b551; --warn-wash: #33260d; --danger: #ff8075; --danger-wash: #3b1714;
    --shadow: 0 1px 2px rgb(0 0 0 / 30%), 0 6px 20px rgb(0 0 0 / 25%);
    --coral: #ff8a6b; --mint: #3dd6a3; --sun: #ffc247; --violet: #a78bfa;
    --sky-top: #070d1a; --sky-mid: #0d1830; --sky-low: #1b1733;
    --cloud: #9db8e8; --cloud-opacity: .07; --spark: #ffe7a8; --spark-2: #cfe0ff;
    color-scheme: dark;
  }
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--sky-mid); color: var(--ink);
  font: 16px/1.55 var(--font-body); -webkit-font-smoothing: antialiased;
}
a { color: var(--blue-strong); text-decoration-thickness: 1px; text-underline-offset: 3px; text-decoration-color: transparent; transition: text-decoration-color .15s; }
a:hover { text-decoration-color: currentColor; }
h1, h2, h3 { font-family: var(--font-display); font-weight: 700; letter-spacing: -0.015em; line-height: 1.15; text-wrap: balance; margin: 0; }
h1 { font-size: clamp(1.75rem, 4vw, 2.25rem); }
h2 { font-size: 1.2rem; }
h3 { font-size: 1.02rem; }
p { margin: 0; }
code, .mono { font-family: var(--font-mono); font-size: .82em; overflow-wrap: anywhere; }
.muted { color: var(--ink-soft); }
.small { font-size: .875rem; }
.eyebrow { display: inline-flex; align-items: center; gap: 6px; font-size: .75rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--violet); }
.eyebrow::before { content: "✦"; color: var(--sun); font-size: .95rem; letter-spacing: 0; }
/* A headline word in the sky gradient, underlined with a sunny squiggle. */
.accent { position: relative; white-space: nowrap;
  background: linear-gradient(100deg, var(--blue) 10%, var(--violet) 55%, var(--coral) 95%); -webkit-background-clip: text; background-clip: text; color: transparent; }
.accent svg { position: absolute; left: 0; right: 0; bottom: -.16em; width: 100%; height: .3em; color: var(--sun); overflow: visible; }
/* One color per feed, so each has its own character. */
.hue-0 { --c: var(--blue); } .hue-1 { --c: var(--violet); } .hue-2 { --c: var(--coral); } .hue-3 { --c: var(--mint); } .hue-4 { --c: var(--sun); }
:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; border-radius: 6px; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }

/* Shell */
.topbar {
  position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--surface) 55%, transparent);
  backdrop-filter: saturate(1.4) blur(12px); -webkit-backdrop-filter: saturate(1.4) blur(12px);
  border-bottom: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
}
body.welcome .topbar { background: transparent; border-bottom-color: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; position: static; }
.topbar-inner, main {
  max-width: 920px; margin: 0 auto;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
}
.topbar-inner { display: flex; align-items: center; gap: 20px; min-height: 60px; }
.brand { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); font: 750 1.15rem/1 var(--font-display); letter-spacing: -0.02em; }
.brand:hover { text-decoration: none; }
.brand svg { width: 28px; height: 28px; color: var(--blue); flex: none; }
.nav { display: flex; gap: 4px; }
.nav a { color: var(--ink-soft); font-weight: 600; font-size: .94rem; padding: 6px 10px; border-radius: 8px; }
.nav a:hover { color: var(--ink); background: var(--sunken); text-decoration: none; }
.nav a[aria-current="page"] { color: var(--ink); }
.topbar .spacer { flex: 1; }
.topbar form { margin: 0; }
.account { display: flex; align-items: center; gap: 12px; min-width: 0; }
.whoami { display: inline-flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 12px 4px 4px; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--line); font-size: .88rem; color: var(--ink-soft); }
.whoami img, .whoami .face { width: 26px; height: 26px; border-radius: 50%; flex: none; object-fit: cover; background: var(--blue-wash); }
.whoami .face { display: grid; place-items: center; color: var(--blue-strong); font-weight: 700; font-size: .8rem; }
.whoami .names { display: flex; gap: 5px; min-width: 0; align-items: baseline; }
.whoami .as { white-space: nowrap; }
.whoami strong { color: var(--ink); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
a.whoami:hover { text-decoration: none; border-color: var(--blue); color: var(--ink-soft); }
@media (max-width: 720px) { .whoami .as { display: none; } }
/* On phones the account gets its own row, so the whole handle fits. */
@media (max-width: 600px) {
  .topbar-inner { flex-wrap: wrap; row-gap: 0; }
  .account { order: 3; flex-basis: 100%; justify-content: space-between; padding-bottom: 10px; }
  .whoami { border-radius: 14px; padding-block: 5px; }
  .whoami .names { flex-direction: column; gap: 1px; }
  .whoami .as { display: inline; font-size: .72rem; line-height: 1.1; }
  .whoami strong { line-height: 1.2; }
}
main { padding-block: 28px 72px; display: grid; gap: 24px; }
main.wide, .topbar.wide .topbar-inner { max-width: 1240px; }
@media (max-width: 520px) { .nav a { padding: 6px 7px; } .topbar-inner { gap: 10px; } .brand span { display: none; } }

/* Page heading */
.page-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px; }
.page-head > div { display: grid; gap: 6px; min-width: 0; }
.page-head h1::after { content: ""; display: block; width: 92px; height: 10px; margin-top: 8px;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 92 10'%3E%3Cpath d='M2 6 C 12 1, 20 1, 30 5 S 50 10, 62 5 S 82 1, 90 5' fill='none' stroke='%23ffb020' stroke-width='3.2' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat; }
.lede { color: var(--ink-soft); max-width: 62ch; }

/* Buttons */
button, .button {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 0 16px;
  border: 1px solid transparent; border-radius: 999px; background: var(--grad); color: var(--on-blue);
  box-shadow: 0 8px 18px -10px color-mix(in srgb, var(--blue) 90%, transparent);
  font: 600 .94rem/1 var(--font-body); cursor: pointer; text-decoration: none; white-space: nowrap;
  transition: background .15s, border-color .15s, color .15s, transform .15s, box-shadow .15s, filter .15s;
}
button:hover, .button:hover { text-decoration: none; filter: brightness(1.07) saturate(1.1); transform: translateY(-1px);
  box-shadow: 0 12px 24px -12px color-mix(in srgb, var(--violet) 90%, transparent); }
button:active, .button:active { transform: translateY(1px); }
button.secondary, .button.secondary { background: var(--surface); color: var(--ink); border-color: var(--line); box-shadow: none; }
button.secondary:hover, .button.secondary:hover { border-color: var(--blue); color: var(--blue-strong); filter: none; box-shadow: 0 8px 18px -12px color-mix(in srgb, var(--blue) 70%, transparent); }
button.danger { background: transparent; color: var(--danger); border-color: var(--line); box-shadow: none; }
button.danger:hover { background: var(--danger-wash); border-color: var(--danger); filter: none; box-shadow: none; }
button.link { background: none; border: 0; min-height: 0; padding: 4px 2px; color: var(--ink-soft); box-shadow: none; }
button.link:hover { color: var(--ink); background: none; transform: none; filter: none; box-shadow: none; }
button:disabled { opacity: .55; cursor: progress; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.actions form { margin: 0; }

/* Panels */
.panel { background: var(--surface); border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: var(--radius); box-shadow: var(--shadow); }
.panel-body { padding: 20px; display: grid; gap: 14px; }
@media (max-width: 520px) { .panel-body { padding: 16px; } }

/* Status pills and chips */
.pill { display: inline-flex; align-items: center; gap: 7px; padding: 3px 10px 3px 8px; border-radius: 999px; font-size: .8rem; font-weight: 600; white-space: nowrap; background: var(--sunken); color: var(--ink-soft); }
.pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.pill.live { background: var(--live-wash); color: var(--live); }
.pill.live::before { animation: ping 2.2s ease-out infinite; }
@keyframes ping { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--live) 55%, transparent); } 80%, 100% { box-shadow: 0 0 0 7px transparent; } }
.pill.warn { background: var(--warn-wash); color: var(--warn); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 5px; font-size: .8rem; padding: 2px 9px; border-radius: 8px;
  background: color-mix(in srgb, var(--c, var(--blue)) 10%, var(--surface)); color: color-mix(in srgb, var(--c, var(--blue)) 45%, var(--ink-soft));
  border: 1px solid color-mix(in srgb, var(--c, var(--blue)) 16%, transparent); }
.chip svg { width: 12px; height: 12px; flex: none; }
.chip.mono { font-family: var(--font-mono); font-size: .75rem; }

/* Notices */
.notice { border-radius: var(--radius-sm); padding: 12px 14px; font-size: .94rem; background: var(--warn-wash); color: var(--warn); }
.notice.error { background: var(--danger-wash); color: var(--danger); white-space: pre-wrap; overflow-wrap: anywhere; }
.notice.ok { background: var(--live-wash); color: var(--live); }
.notice a { color: inherit; text-decoration-color: currentColor; }
.notice ul { margin: 6px 0 0; padding-left: 20px; }

/* Forms */
label { display: block; font-weight: 600; font-size: .92rem; margin: 0 0 6px; }
label.check { display: flex; align-items: center; gap: 10px; font-weight: 500; margin: 0; cursor: pointer; }
input, select, textarea {
  width: 100%; min-height: 42px; padding: 9px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm);
  background: var(--sunken); color: var(--ink); font: 400 .95rem/1.4 var(--font-body); transition: border-color .15s, background .15s;
}
input:hover, select:hover, textarea:hover { border-color: color-mix(in srgb, var(--blue) 40%, var(--line)); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--blue); background: var(--surface); box-shadow: 0 0 0 3px var(--blue-wash); }
input[type=checkbox] { width: 18px; height: 18px; min-height: 0; padding: 0; accent-color: var(--blue); flex: none; }
input[type=file] { padding: 7px; }
input[readonly] { color: var(--ink-soft); background: transparent; }
textarea { min-height: 72px; resize: vertical; }
textarea.code { font: 400 .82rem/1.55 var(--font-mono); min-height: 320px; }
.field { display: grid; gap: 0; min-width: 0; }
.hint { font-size: .84rem; color: var(--ink-soft); font-weight: 400; margin-top: 6px; }
.fields { display: grid; gap: 18px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 16px; }
.checks { display: flex; flex-wrap: wrap; gap: 10px 24px; }

/* Timeline (post previews) */
.timeline { background: var(--surface); border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); }
.post { display: grid; grid-template-columns: 44px 1fr; gap: 12px; padding: 14px 16px; border-top: 1px solid var(--line); }
.post:first-child { border-top: 0; }
.post .avatar { width: 44px; height: 44px; border-radius: 50%; background: var(--sunken); object-fit: cover; }
.post .body { min-width: 0; display: grid; gap: 4px; }
.post .who { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.post .who strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.post .who .handle { color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.post .who .time { margin-left: auto; color: var(--ink-soft); font-size: .88rem; flex: none; }
.post .note { font-size: .8rem; color: var(--ink-soft); font-weight: 600; }
.post .text { white-space: pre-wrap; overflow-wrap: anywhere; }
.post .thumbs { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px; margin-top: 4px; }
.post .thumbs img { width: 100%; max-height: 220px; border-radius: 10px; object-fit: cover; border: 1px solid var(--line); }
.stats { display: flex; gap: 18px; font-size: .84rem; color: var(--ink-soft); font-variant-numeric: tabular-nums; margin-top: 2px; }
.empty { padding: 32px 20px; text-align: center; color: var(--ink-soft); }

/* The sky behind every page: drifting clouds, sparkles and the odd little feed card. Purely decorative. */
.sky { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none;
  background: linear-gradient(180deg, var(--sky-top) 0%, var(--sky-mid) 42%, var(--sky-low) 100%); }
.glow { position: absolute; border-radius: 50%; animation: drift 26s ease-in-out infinite alternate; }
.glow.g1 { width: 46vmax; height: 46vmax; left: -14vmax; top: -18vmax; background: radial-gradient(circle, color-mix(in srgb, var(--blue) 28%, transparent), transparent 68%); }
.glow.g2 { width: 40vmax; height: 40vmax; right: -12vmax; top: 22vh; background: radial-gradient(circle, color-mix(in srgb, var(--coral) 20%, transparent), transparent 68%); animation-duration: 32s; }
.glow.g3 { width: 38vmax; height: 38vmax; left: 18vw; bottom: -24vmax; background: radial-gradient(circle, color-mix(in srgb, var(--mint) 18%, transparent), transparent 68%); animation-duration: 38s; }
@keyframes drift { to { transform: translate(4vw, 3vh) scale(1.08); } }

.cloud { position: absolute; fill: var(--cloud); opacity: var(--cloud-opacity); animation: sail linear infinite; }
.cloud.c1 { width: 230px; top: 12vh; left: -260px; animation-duration: 95s; }
.cloud.c2 { width: 150px; top: 58vh; left: -200px; animation-duration: 120s; animation-delay: -60s; }
.cloud.c3 { width: 300px; top: 78vh; left: -320px; animation-duration: 140s; animation-delay: -100s; }
.cloud.c4 { width: 120px; top: 30vh; left: -160px; animation-duration: 80s; animation-delay: -30s; }
@keyframes sail { to { transform: translateX(calc(100vw + 360px)); } }

.spark { position: absolute; width: 14px; height: 14px; background: var(--spark);
  clip-path: polygon(50% 0, 61% 39%, 100% 50%, 61% 61%, 50% 100%, 39% 61%, 0 50%, 39% 39%); animation: twinkle 3.2s ease-in-out infinite; }
.spark:nth-child(even) { background: var(--spark-2); width: 10px; height: 10px; }
@keyframes twinkle { 0%, 100% { transform: scale(.55) rotate(0); opacity: .45; } 50% { transform: scale(1.15) rotate(20deg); opacity: 1; } }

.flier { position: absolute; width: 168px; padding: 10px 12px; display: grid; grid-template-columns: 26px 1fr; gap: 4px 9px; align-items: center;
  background: color-mix(in srgb, var(--surface) 88%, transparent); border: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  border-radius: 14px; box-shadow: 0 10px 30px rgb(14 26 43 / 10%); animation: bob 7s ease-in-out infinite alternate; opacity: .85; }
.flier i { width: 26px; height: 26px; border-radius: 50%; grid-row: span 2; background: var(--c, var(--blue)); }
.flier b { height: 7px; border-radius: 4px; background: var(--sunken); }
.flier b + b { width: 64%; }
.flier small { grid-column: 2; font: 600 .7rem/1 var(--font-body); color: var(--c, var(--blue)); }
@keyframes bob { from { translate: 0 0; } to { translate: 0 -16px; } }
.flier.f1 { bottom: 5vh; left: 4vw; rotate: -7deg; --c: var(--coral); }
.flier.f2 { top: 8vh; left: 36vw; rotate: 5deg; --c: var(--mint); animation-duration: 8.5s; }
.flier.f3 { top: 9vh; right: 5vw; rotate: 6deg; --c: var(--violet); animation-duration: 6.5s; }
.flier.f4 { bottom: 9vh; right: 9vw; rotate: -4deg; --c: var(--sun); animation-duration: 9s; }
.flier.f5 { top: 64vh; left: 48vw; rotate: 3deg; --c: var(--blue); animation-duration: 7.5s; opacity: .6; }
.trail { position: absolute; top: 4vh; right: 14vw; width: 300px; color: color-mix(in srgb, var(--blue) 45%, transparent); }
/* Narrower screens keep only the fliers that sit clear of the text. */
@media (max-width: 1200px) { .flier.f1, .flier.f2, .flier.f5 { display: none; } }
@media (max-width: 880px) { .flier { opacity: .5; } .flier.f4, .trail { display: none; } .flier.f3 { top: 2vh; right: -50px; } }

/* In the app, a few cards drift in the margins, only where there's room beside the content. */
.flier.s1 { top: 26vh; left: 1.5vw; rotate: -6deg; --c: var(--coral); }
.flier.s2 { top: 64vh; right: 1.5vw; rotate: 5deg; --c: var(--mint); animation-duration: 8.5s; }
.flier.s3 { top: 12vh; right: 2vw; rotate: -3deg; --c: var(--violet); animation-duration: 6.5s; }
@media (max-width: 1340px) { .flier.s1, .flier.s2, .flier.s3 { display: none; } }
`

const CLOUD = '<svg class="cloud CLASS" viewBox="0 0 200 90"><circle cx="58" cy="56" r="30"/><circle cx="100" cy="40" r="38"/><circle cx="146" cy="56" r="28"/><rect x="38" y="54" width="128" height="32" rx="16"/></svg>'

/** A hand-drawn underline, used under accented headline words. */
export const SQUIGGLE =
  '<svg viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden="true"><path d="M2 14 C 30 2, 50 2, 70 12 S 120 20, 140 9 S 180 2, 198 10" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round"/></svg>'

const flier = (cls: string, label: string) => `<div class="flier ${cls}"><i></i><b></b><b></b><small>${label}</small></div>`
const sparks = (spots: number[][]) =>
  spots.map(([top, left], i) => `<span class="spark" style="top:${top}vh;left:${left}vw;animation-delay:${(i * 0.37) % 3}s"></span>`).join('')

/** The welcome page gets the full show; app pages a calmer sky that stays out of the way of the work. */
const SKIES = {
  welcome: `<div class="sky" aria-hidden="true">
  <span class="glow g1"></span><span class="glow g2"></span><span class="glow g3"></span>
  ${['c1', 'c2', 'c3', 'c4'].map((c) => CLOUD.replace('CLASS', c)).join('')}
  <svg class="trail" viewBox="0 0 300 120" fill="none"><path d="M4 110 C 70 100, 90 30, 160 46 S 250 70, 270 22" stroke="currentColor" stroke-width="2" stroke-dasharray="2 8" stroke-linecap="round"/><path d="M262 14 l28 -8 -10 27 -6 -11 z" fill="currentColor"/></svg>
  ${sparks([[8, 30], [14, 72], [22, 48], [6, 88], [34, 92], [48, 6], [70, 14], [82, 40], [90, 70], [62, 84], [40, 38], [76, 60]])}
  ${flier('f1', '♥ 128')}${flier('f2', '↻ 42')}${flier('f3', '♥ 1.2k')}${flier('f4', '★ new')}${flier('f5', '♥ 9')}
</div>`,
  app: `<div class="sky" aria-hidden="true">
  <span class="glow g1"></span><span class="glow g2"></span><span class="glow g3"></span>
  ${['c1', 'c2', 'c3'].map((c) => CLOUD.replace('CLASS', c)).join('')}
  ${sparks([[10, 4], [26, 95], [52, 2], [72, 97], [88, 8], [93, 55], [40, 93], [6, 62]])}
  ${flier('s1', '♥ 128')}${flier('s2', '↻ 42')}
</div>`,
  wide: `<div class="sky" aria-hidden="true">
  <span class="glow g1"></span><span class="glow g2"></span><span class="glow g3"></span>
  ${['c1', 'c3'].map((c) => CLOUD.replace('CLASS', c)).join('')}
  ${sparks([[10, 3], [52, 1.5], [88, 6], [93, 55], [6, 62]])}
</div>`,
}

/** A stable color for a feed, picked from its id. */
export function hueOf(id: string): string {
  let n = 0
  for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) >>> 0
  return `hue-${n % 5}`
}

export function layout(
  title: string,
  body: Html,
  viewer: Viewer = anonymous,
  opts: { current?: 'feeds' | 'playground'; wide?: boolean; welcome?: boolean } = {},
): Html {
  const here = (page: 'feeds' | 'playground') => (opts.current === page ? raw('aria-current="page"') : '')
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${title}</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="${FONTS}" />
    <style>${raw(STYLE)}</style>
  </head>
  <body${opts.welcome ? raw(' class="welcome"') : ''}>
    ${raw(SKIES[opts.welcome ? 'welcome' : opts.wide ? 'wide' : 'app'])}
    <header class="topbar${opts.wide || opts.welcome ? raw(' wide') : ''}">
      <div class="topbar-inner">
        <a class="brand" href="/">${raw(MARK)}<span>${SITE_NAME}</span></a>
        ${opts.welcome
          ? ''
          : html`<nav class="nav" aria-label="Main">
              <a href="/" ${here('feeds')}>Feeds</a>
              <a href="/playground" ${here('playground')}>Playground</a>
            </nav>`}
        <span class="spacer"></span>
        ${viewer.signedIn
          ? html`<div class="account">
              ${whoami(viewer)}
              <form method="post" action="/logout"><button class="link" type="submit">Sign out</button></form>
            </div>`
          : viewer.canSignIn && !opts.welcome
            ? html`<a class="button secondary" href="/login">Sign in</a>`
            : ''}
      </div>
    </header>
    <main${opts.wide || opts.welcome ? raw(' class="wide"') : ''}>${body}</main>
  </body>
</html>`
}

/** "Signed in as @handle", with the account's avatar, so it's clear which account is in use. */
function whoami(viewer: Viewer): Html {
  if (!viewer.handle) return html`<span class="whoami"><span class="face" aria-hidden="true">✓</span><span>Signed in</span></span>`
  const face = viewer.avatar
    ? html`<img src="${viewer.avatar}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : html`<span class="face" aria-hidden="true">${viewer.handle.slice(0, 1).toUpperCase()}</span>`
  return html`<a class="whoami" href="https://bsky.app/profile/${viewer.handle}" target="_blank" rel="noopener" title="Signed in as @${viewer.handle}">
    ${face}<span class="names"><span class="as">Signed in as</span><strong>@${viewer.handle}</strong></span>
  </a>`
}

export function notice(message: string | Html, kind: '' | 'error' | 'ok' = ''): Html {
  return html`<div class="notice ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${message}</div>`
}
