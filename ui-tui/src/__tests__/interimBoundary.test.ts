import { describe, expect, it } from 'vitest'

import { streamedInterimPrefixLength } from '../lib/interimBoundary.js'

describe('streamedInterimPrefixLength', () => {
  it.each([
    ['hello', 'hello world', 5],
    ['before hello', 'hello world', 5],
    ['hello   there', 'hello there world', 13],
    ['before hello   there', 'hello there world', 13],
    ['ababab', 'ababx', 4],
    ['wrong', 'hello', 0],
    ['😀he', 'hello', 2]
  ])('finds the authoritative prefix at the streamed suffix', (streamed, authoritative, expected) => {
    expect(streamedInterimPrefixLength(streamed, authoritative)).toBe(expected)
  })
})
