const unicodeWhitespace = /\p{White_Space}/u

function isPythonWhitespace(character: string): boolean {
  const codeUnit = character.charCodeAt(0)

  return unicodeWhitespace.test(character) || (codeUnit >= 0x1c && codeUnit <= 0x1f)
}

function normalizeVisibleText(rawText: string): { rawStarts: number[]; text: string } {
  const rawStarts: number[] = []
  let pendingWhitespaceStart: number | null = null
  let text = ''

  for (let index = 0; index < rawText.length; index += 1) {
    const character = rawText[index]

    if (isPythonWhitespace(character)) {
      if (text && pendingWhitespaceStart === null) {
        pendingWhitespaceStart = index
      }

      continue
    }

    if (pendingWhitespaceStart !== null) {
      text += ' '
      rawStarts.push(pendingWhitespaceStart)
      pendingWhitespaceStart = null
    }

    text += character
    rawStarts.push(index)
  }

  return { rawStarts, text }
}

/**
 * Return the raw UTF-16 length of the longest suffix of `streamedText` whose
 * whitespace-normalized form is a prefix of the normalized authoritative
 * interim text.
 *
 * The gateway uses Python's `\s+` collapse plus `strip()` before declaring an
 * interim already streamed. Keep the client contract equivalent while mapping
 * the normalized overlap back to the original stream offset. A linear
 * prefix-function scan avoids quadratic work on long model responses.
 */
export function streamedInterimPrefixLength(streamedText: string, authoritativeText: string): number {
  if (!streamedText || !authoritativeText) {
    return 0
  }

  const streamed = normalizeVisibleText(streamedText)
  const authoritative = normalizeVisibleText(authoritativeText).text

  if (!streamed.text || !authoritative) {
    return 0
  }

  const fallback = new Array<number>(authoritative.length).fill(0)

  for (let index = 1, matched = 0; index < authoritative.length; index += 1) {
    while (matched > 0 && authoritative[index] !== authoritative[matched]) {
      matched = fallback[matched - 1]
    }

    if (authoritative[index] === authoritative[matched]) {
      matched += 1
    }

    fallback[index] = matched
  }

  let matched = 0

  for (let index = 0; index < streamed.text.length; index += 1) {
    while (matched > 0 && streamed.text[index] !== authoritative[matched]) {
      matched = fallback[matched - 1]
    }

    if (streamed.text[index] === authoritative[matched]) {
      matched += 1
    }

    if (matched === authoritative.length && index < streamed.text.length - 1) {
      matched = fallback[matched - 1]
    }
  }

  if (matched === 0) {
    return 0
  }

  const normalizedSuffixStart = streamed.text.length - matched

  return streamedText.length - streamed.rawStarts[normalizedSuffixStart]
}
