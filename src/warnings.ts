import type { AppDeps } from './app.js'

/** Configuration problems worth showing at the top of the dashboard. */
export function setupWarnings({ config, bsky, manage }: AppDeps, feeds: { sources: { type: string }[] }[]): string[] {
  const warnings: string[] = []
  if (!config.hostname) {
    warnings.push("FEEDGEN_HOSTNAME isn't set, so the hostname is taken from each request. Set it before publishing.")
  }
  if (!config.publisherDid && (!config.bsky.identifier || config.bsky.identifier.includes('@'))) {
    warnings.push("Can't tell which account owns these feeds. Set BSKY_IDENTIFIER to your handle, or set FEEDGEN_PUBLISHER_DID.")
  }
  const needsLogin = feeds.some((f) => f.sources.some((s) => s.type === 'search' || s.type === 'likes'))
  if (needsLogin && !bsky.hasAppPassword && !manage) {
    warnings.push('Some feeds use search or likes, which need BSKY_IDENTIFIER and BSKY_APP_PASSWORD.')
  }
  return warnings
}
