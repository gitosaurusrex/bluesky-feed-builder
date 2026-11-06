export interface Config {
  /** Public hostname of this service, e.g. `my-feeds.vercel.app`. Falls back to the request's Host header. */
  hostname?: string
  /** DID that identifies this feed generator service. Defaults to did:web:<hostname>. */
  serviceDid?: string
  /** DID of the account that publishes the feeds. Resolved from BSKY_IDENTIFIER when unset. */
  publisherDid?: string
  bsky: {
    /** PDS used to log in, e.g. https://bsky.social. */
    service: string
    identifier?: string
    appPassword?: string
  }
  /** Unauthenticated AppView used for public reads. */
  publicApi: string
  /** Enables the playground's preview API without signing in. */
  adminToken?: string
  /** Handles or DIDs of other accounts that may sign in and run their own feeds here. */
  allowedAccounts: string[]
  /** Turso or SQLite. Turns on sign-in and the feed editor. */
  database?: { url: string; authToken?: string }
  oauth: {
    /** ES256 private JWK from `npm run oauth-key`. Optional: one is generated and stored in the database otherwise. */
    privateKey?: string
    /** Overrides the requested OAuth scope. */
    scope?: string
  }
  cacheSeconds: number
  /** How long expired results may still be served while a refresh runs in the background. */
  staleSeconds: number
  port: number
}

const int = (value: string | undefined, fallback: number) => {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const nonEmpty = (value: string | undefined) => (value?.trim() ? value.trim() : undefined)

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const hostname = nonEmpty(env.FEEDGEN_HOSTNAME) ?? nonEmpty(env.VERCEL_PROJECT_PRODUCTION_URL) ?? nonEmpty(env.RENDER_EXTERNAL_HOSTNAME)
  return {
    hostname: hostname?.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    serviceDid: nonEmpty(env.FEEDGEN_SERVICE_DID),
    publisherDid: nonEmpty(env.FEEDGEN_PUBLISHER_DID),
    bsky: {
      service: nonEmpty(env.BSKY_SERVICE) ?? 'https://bsky.social',
      identifier: nonEmpty(env.BSKY_IDENTIFIER)?.replace(/^@/, ''),
      appPassword: nonEmpty(env.BSKY_APP_PASSWORD),
    },
    publicApi: nonEmpty(env.BSKY_PUBLIC_API) ?? 'https://public.api.bsky.app',
    adminToken: nonEmpty(env.ADMIN_TOKEN),
    allowedAccounts: (env.ALLOWED_ACCOUNTS ?? '')
      .split(/[\s,]+/)
      .map((a) => a.replace(/^@/, '').trim())
      .filter(Boolean),
    database: nonEmpty(env.TURSO_DATABASE_URL)
      ? { url: nonEmpty(env.TURSO_DATABASE_URL)!, authToken: nonEmpty(env.TURSO_AUTH_TOKEN) }
      : undefined,
    oauth: { privateKey: nonEmpty(env.OAUTH_PRIVATE_KEY), scope: nonEmpty(env.OAUTH_SCOPE) },
    cacheSeconds: int(env.CACHE_SECONDS, 60),
    staleSeconds: int(env.STALE_SECONDS, 600),
    port: int(env.PORT, 3000),
  }
}

/** Loads `.env` when present. Hosting platforms inject real environment variables instead. */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile()
  } catch {
    // No .env file, which is normal in production.
  }
}
