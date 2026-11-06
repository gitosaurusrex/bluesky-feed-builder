import { type Agent, AtpAgent, AtUri, XRPCError } from '@atproto/api'
import type { Config } from './config.js'

type Collection = 'app.bsky.feed.post' | 'app.bsky.graph.list' | 'app.bsky.feed.generator'

const URL_SEGMENT: Record<Collection, string> = {
  'app.bsky.feed.post': 'post',
  'app.bsky.graph.list': 'lists',
  'app.bsky.feed.generator': 'feed',
}

export class MissingCredentialsError extends Error {
  constructor(what: string, canSignIn: boolean) {
    super(
      canSignIn
        ? `${what} needs a Bluesky login. Sign in on the dashboard, or set BSKY_APP_PASSWORD.`
        : `${what} requires BSKY_IDENTIFIER and BSKY_APP_PASSWORD to be set`,
    )
  }
}

export interface BskyOptions {
  /**
   * An account's signed-in session from the dashboard, used for search and
   * likes. Resolves undefined when that account hasn't signed in.
   */
  sessionAgent?: (did: string) => Promise<Agent | undefined>
}

/**
 * Thin wrapper around two agents: an anonymous one for public reads, and a
 * signed-in one for endpoints Bluesky only serves to signed-in users, such as
 * search. The signed-in agent uses the app password if there is one, and
 * otherwise the owner's dashboard login.
 */
export class Bsky {
  readonly public: AtpAgent
  private authed?: Promise<AtpAgent>
  private dids = new Map<string, Promise<string>>()
  private owner?: Promise<string | undefined>

  constructor(
    private readonly config: Pick<Config, 'bsky' | 'publicApi' | 'publisherDid'>,
    private readonly options: BskyOptions = {},
  ) {
    this.public = new AtpAgent({ service: config.publicApi })
  }

  get hasAppPassword(): boolean {
    return Boolean(this.config.bsky.identifier && this.config.bsky.appPassword)
  }

  /**
   * The account that owns and publishes the feeds: FEEDGEN_PUBLISHER_DID, or
   * the DID behind the BSKY_IDENTIFIER handle.
   */
  ownerDid(): Promise<string | undefined> {
    if (this.config.publisherDid) return Promise.resolve(this.config.publisherDid)
    const identifier = this.config.bsky.identifier
    if (!identifier || identifier.includes('@')) return Promise.resolve(undefined)
    this.owner ??= this.resolveDid(identifier).catch((err) => {
      console.error(`Couldn't resolve BSKY_IDENTIFIER "${identifier}" to a DID:`, err)
      this.owner = undefined
      return undefined
    })
    return this.owner
  }

  /**
   * A signed-in agent for `did` (the admin when omitted): the app password,
   * which belongs to the admin, or else that account's dashboard login.
   */
  async authedAgent(what = 'This request', did?: string): Promise<Agent> {
    const admin = await this.ownerDid()
    const account = did ?? admin
    if (this.hasAppPassword && (!did || did === admin)) return this.appPasswordAgent()
    const agent = account ? await this.options.sessionAgent?.(account) : undefined
    if (!agent) throw new MissingCredentialsError(what, Boolean(this.options.sessionAgent))
    return agent
  }

  /** Logs in once per process. Sessions refresh themselves; a failed login is retried on the next call. */
  private appPasswordAgent(): Promise<AtpAgent> {
    this.authed ??= (async () => {
      const agent = new AtpAgent({ service: this.config.bsky.service })
      await agent.login({ identifier: this.config.bsky.identifier!, password: this.config.bsky.appPassword! })
      return agent
    })().catch((err) => {
      this.authed = undefined
      throw err
    })
    return this.authed
  }

  /**
   * Runs a read on the public AppView, retrying with the logged-in agent when
   * Bluesky refuses anonymous access.
   */
  async read<T>(fn: (agent: Agent) => Promise<T>): Promise<T> {
    try {
      return await fn(this.public)
    } catch (err) {
      const status = err instanceof XRPCError ? err.status : undefined
      if (status !== 401 && status !== 403) throw err
      const agent = await this.authedAgent().catch(() => undefined)
      if (!agent) throw err
      return fn(agent)
    }
  }

  /** Reads a record directly from the PDS that hosts it, including fields the AppView doesn't pass on. */
  async getRecord(uri: string): Promise<Record<string, unknown>> {
    const at = new AtUri(uri)
    const pds = await this.pdsOf(at.host)
    const params = new URLSearchParams({ repo: at.host, collection: at.collection, rkey: at.rkey })
    const res = await fetch(`${pds}/xrpc/com.atproto.repo.getRecord?${params}`)
    if (!res.ok) throw new Error(`Couldn't load ${uri} (HTTP ${res.status})`)
    return ((await res.json()) as { value: Record<string, unknown> }).value
  }

  private async pdsOf(did: string): Promise<string> {
    const docUrl = did.startsWith('did:plc:')
      ? `https://plc.directory/${did}`
      : did.startsWith('did:web:')
        ? `https://${decodeURIComponent(did.slice('did:web:'.length))}/.well-known/did.json`
        : undefined
    if (!docUrl) throw new Error(`Unsupported DID: ${did}`)
    const res = await fetch(docUrl)
    if (!res.ok) throw new Error(`Couldn't resolve ${did} (HTTP ${res.status})`)
    const doc = (await res.json()) as { service?: { id: string; serviceEndpoint: unknown }[] }
    const pds = doc.service?.find((s) => s.id === '#atproto_pds' || s.id === `${did}#atproto_pds`)?.serviceEndpoint
    if (typeof pds !== 'string') throw new Error(`${did} has no PDS`)
    return pds.replace(/\/+$/, '')
  }

  /** Resolves a handle to a DID (DIDs pass through). Results are cached for the life of the process. */
  resolveDid(actor: string): Promise<string> {
    const key = actor.trim().replace(/^@/, '').toLowerCase()
    if (key.startsWith('did:')) return Promise.resolve(key)
    let did = this.dids.get(key)
    if (!did) {
      did = this.public.com.atproto.identity.resolveHandle({ handle: key }).then((res) => res.data.did)
      did.catch(() => this.dids.delete(key))
      this.dids.set(key, did)
    }
    return did
  }

  /** Accepts an at:// URI or a bsky.app URL and returns an at:// URI with a DID authority. */
  async toAtUri(input: string, collection: Collection): Promise<string> {
    const value = input.trim()
    let authority: string
    let rkey: string
    if (value.startsWith('at://')) {
      const uri = new AtUri(value)
      if (uri.collection !== collection) throw new Error(`Expected a ${collection} URI, got ${value}`)
      authority = uri.host
      rkey = uri.rkey
    } else {
      const match = new URL(value).pathname.match(/^\/profile\/([^/]+)\/([^/]+)\/([^/]+)\/?$/)
      if (!match || match[2] !== URL_SEGMENT[collection]) {
        throw new Error(`Expected a bsky.app/profile/<handle>/${URL_SEGMENT[collection]}/<id> URL, got ${value}`)
      }
      authority = decodeURIComponent(match[1]!)
      rkey = match[3]!
    }
    return `at://${await this.resolveDid(authority)}/${collection}/${rkey}`
  }
}
