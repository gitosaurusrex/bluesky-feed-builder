import { createHash, randomBytes } from 'node:crypto'
import { Agent } from '@atproto/api'
import {
  JoseKey,
  NodeOAuthClient,
  type NodeSavedSession,
  type NodeSavedState,
  type OAuthClientMetadataInput,
  buildAtprotoLoopbackClientMetadata,
} from '@atproto/oauth-client-node'
import type { Config } from './config.js'
import type { Database } from './db.js'

export const APPVIEW_SERVICE = 'did:web:api.bsky.app#bsky_appview'

const appview = (lxm: string) => `rpc:${lxm}?aud=${APPVIEW_SERVICE.replace('#', '%23')}`

/**
 * Only what the dashboard needs: write feed records, upload feed avatars, and
 * run the two signed-in-only feed sources. It can't post, follow or read DMs.
 */
export const DEFAULT_SCOPE = [
  'atproto',
  'repo:app.bsky.feed.generator',
  'blob:image/*',
  appview('app.bsky.feed.searchPosts'),
  appview('app.bsky.feed.getActorLikes'),
].join(' ')

const LOGIN_TTL_MS = 30 * 24 * 3_600_000
export const LOGIN_COOKIE = 'feedbuilder_login'

export function isLocalHostname(hostname: string | undefined): boolean {
  return !hostname || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(hostname)
}

export interface OwnerAuth {
  client: NodeOAuthClient
  /** Running on localhost with Bluesky's development client, whose sessions are short-lived. */
  local: boolean
  /** Signs its requests with a private key, which lets sessions last far longer than unsigned ones. */
  confidential: boolean
  /** Where Bluesky sends the browser back to after sign-in. */
  redirectUri: string
  /** The owner's session for AppView calls (search, likes), or undefined if they never signed in. */
  appviewAgent(ownerDid: string): Promise<Agent | undefined>
  /** The owner's session for writes to their own repo (publishing). */
  repoAgent(ownerDid: string): Promise<Agent | undefined>
}

/** Generates a key for OAUTH_PRIVATE_KEY. */
export async function generateOAuthKey(): Promise<string> {
  const key = await JoseKey.generate(['ES256'], `key-${Date.now()}`)
  return JSON.stringify(key.privateJwk)
}

export async function createOwnerAuth(config: Config, db: Database): Promise<OwnerAuth> {
  const scope = config.oauth.scope ?? DEFAULT_SCOPE
  const local = isLocalHostname(config.hostname)
  // In production the client signs its requests, which Bluesky rewards with long-lived sessions. The key comes
  // from OAUTH_PRIVATE_KEY, or is generated once and kept in the database next to the sessions it protects.
  const privateKey = local
    ? undefined
    : (config.oauth.privateKey ?? (await db.getOrCreate('config', 'oauth-private-key', generateOAuthKey)))
  const keyset = privateKey ? [await JoseKey.fromImportable(privateKey)] : undefined

  let clientMetadata: OAuthClientMetadataInput
  let redirectUri: string
  if (local) {
    // Bluesky accepts this special client on 127.0.0.1 without hosting any metadata.
    redirectUri = `http://127.0.0.1:${config.port}/oauth/callback`
    clientMetadata = buildAtprotoLoopbackClientMetadata({ scope, redirect_uris: [redirectUri] })
  } else {
    const origin = `https://${config.hostname}`
    redirectUri = `${origin}/oauth/callback`
    clientMetadata = {
      client_id: `${origin}/client-metadata.json`,
      client_name: 'Blue Feeds',
      client_uri: origin,
      redirect_uris: [redirectUri],
      scope,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
      dpop_bound_access_tokens: true,
      ...(keyset
        ? { token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: 'ES256', jwks_uri: `${origin}/oauth/jwks.json` }
        : { token_endpoint_auth_method: 'none' }),
    }
  }

  const sessions = db.kv<NodeSavedSession>('oauth-session')
  const client = new NodeOAuthClient({
    clientMetadata,
    keyset,
    stateStore: db.kv<NodeSavedState>('oauth-state', 3_600_000),
    sessionStore: sessions,
    requestLock: (name, fn) => db.withLock(`oauth:${name}`, fn),
  })

  const restore = async (did: string): Promise<Agent | undefined> => {
    if (!(await sessions.get(did))) return undefined
    try {
      return new Agent(await client.restore(did))
    } catch (err) {
      console.error('Restoring the Bluesky login failed. Sign in on the dashboard again.', err)
      return undefined
    }
  }

  return {
    client,
    local,
    confidential: Boolean(keyset),
    redirectUri,
    async appviewAgent(did) {
      const agent = await restore(did)
      agent?.configureProxy(APPVIEW_SERVICE)
      return agent
    },
    repoAgent: restore,
  }
}

/**
 * Dashboard logins. The browser keeps a random token in a cookie; the database
 * keeps only its hash, so a leaked database can't be used to sign in.
 */
export class Logins {
  private readonly store

  constructor(db: Database) {
    this.store = db.kv<{ did: string }>('login', LOGIN_TTL_MS)
  }

  static readonly maxAgeSeconds = LOGIN_TTL_MS / 1000

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex')
  }

  async create(did: string): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    await this.store.set(this.hash(token), { did })
    return token
  }

  async get(token: string | undefined): Promise<string | undefined> {
    return token ? (await this.store.get(this.hash(token)))?.did : undefined
  }

  async delete(token: string | undefined): Promise<void> {
    if (token) await this.store.del(this.hash(token))
  }
}
