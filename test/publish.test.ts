import { describe, expect, it } from 'vitest'
import { avatarUrl } from '../src/publish.js'

describe('avatarUrl', () => {
  const cid = 'bafkreiglgcfnjzvi7xjxd6blfxw2citnqdy2g4kckv555j7eoqmz3xxqlu'
  const expected = `https://cdn.bsky.app/img/avatar/plain/did:plc:me/${cid}`

  it('reads blob refs from the API and from raw JSON', () => {
    expect(avatarUrl('did:plc:me', { ref: { toString: () => cid } })).toBe(expected)
    expect(avatarUrl('did:plc:me', { ref: { $link: cid } })).toBe(expected)
  })

  it('ignores missing or odd values', () => {
    expect(avatarUrl('did:plc:me', undefined)).toBeUndefined()
    expect(avatarUrl('did:plc:me', { ref: '"><script>' })).toBeUndefined()
  })
})
