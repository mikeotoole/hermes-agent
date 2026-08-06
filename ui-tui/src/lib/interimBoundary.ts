/**
 * Return the UTF-16 length of the longest suffix of `streamedText` that is a
 * prefix of the authoritative interim text.
 *
 * The gateway may seal an interim while only a prefix of it has reached the
 * delta stream. A linear prefix-function scan avoids quadratic work on long
 * model responses while preserving JavaScript's UTF-16 offset semantics.
 */
export function streamedInterimPrefixLength(streamedText: string, authoritativeText: string): number {
  if (!streamedText || !authoritativeText) {
    return 0
  }

  const fallback = new Array<number>(authoritativeText.length).fill(0)

  for (let index = 1, matched = 0; index < authoritativeText.length; index += 1) {
    while (matched > 0 && authoritativeText[index] !== authoritativeText[matched]) {
      matched = fallback[matched - 1]
    }

    if (authoritativeText[index] === authoritativeText[matched]) {
      matched += 1
    }

    fallback[index] = matched
  }

  let matched = 0

  for (let index = 0; index < streamedText.length; index += 1) {
    while (matched > 0 && streamedText[index] !== authoritativeText[matched]) {
      matched = fallback[matched - 1]
    }

    if (streamedText[index] === authoritativeText[matched]) {
      matched += 1
    }

    if (matched === authoritativeText.length && index < streamedText.length - 1) {
      matched = fallback[matched - 1]
    }
  }

  return matched
}
