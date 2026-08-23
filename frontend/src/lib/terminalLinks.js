const HTTP_URL = /https?:\/\/[^\s<>"'`]+/giu
const SIMPLE_TRAILING_PUNCTUATION = /[.,;:!?]+$/u

function trimUnmatchedCloser(value, closer, opener) {
  let result = value
  while (result.endsWith(closer)) {
    const openCount = [...result].filter(char => char === opener).length
    const closeCount = [...result].filter(char => char === closer).length
    if (closeCount <= openCount) break
    result = result.slice(0, -closer.length)
  }
  return result
}

export function cleanTerminalUrl(value) {
  let result = value.replace(SIMPLE_TRAILING_PUNCTUATION, '')
  result = trimUnmatchedCloser(result, ')', '(')
  result = trimUnmatchedCloser(result, ']', '[')
  result = trimUnmatchedCloser(result, '}', '{')
  return result
}

export function findHttpUrls(text) {
  const matches = []
  HTTP_URL.lastIndex = 0
  let match = HTTP_URL.exec(text)
  while (match) {
    const url = cleanTerminalUrl(match[0])
    if (url.length > 'https://'.length) matches.push({ url, index: match.index })
    match = HTTP_URL.exec(text)
  }
  return matches
}

export function extractHttpUrls(text) {
  const ordered = new Map()
  for (const { url } of findHttpUrls(text)) {
    ordered.delete(url)
    ordered.set(url, true)
  }
  return [...ordered.keys()]
}
