const HTTP_URL = /https?:\/\/[^\s<>"'`]+/giu
const HTTP_PREFIX = /https?:\/\//giu
const SIMPLE_TRAILING_PUNCTUATION = /[.,;:!?]+$/u
const URL_BREAK = /[\s<>"'`]/u

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

// Terminal UIs often lay text out themselves instead of letting the terminal
// soft-wrap it. In that case every physical row is marked as a separate line,
// even though a long OAuth URL visibly continues at the left edge of the next
// row. Reassemble a URL only when its current segment reaches the physical
// right edge; ordinary lines with trailing blank cells stay separate.
export function findTerminalLineUrls(lines, rowOffset = 0) {
  const matches = []

  for (let row = 0; row < lines.length; row++) {
    HTTP_PREFIX.lastIndex = 0
    let prefix = HTTP_PREFIX.exec(lines[row])
    while (prefix) {
      let currentRow = row
      let column = prefix.index
      let value = ''
      const positions = []

      while (currentRow < lines.length && positions.length < 8192) {
        const line = lines[currentRow]
        while (column < line.length && !URL_BREAK.test(line[column])) {
          value += line[column]
          positions.push({ x: column, y: rowOffset + currentRow })
          column++
        }

        // Whitespace or punctuation inside the row is a real URL boundary.
        if (column < line.length || currentRow + 1 >= lines.length) break

        const next = lines[currentRow + 1]
        const nextColumn = next.search(/\S/u)
        if (nextColumn < 0 || /^https?:\/\//iu.test(next.slice(nextColumn))) break
        currentRow++
        column = nextColumn
      }

      const url = cleanTerminalUrl(value)
      if (url.length > 'https://'.length) {
        try {
          const parsed = new URL(url)
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            const end = positions[url.length - 1]
            if (end) matches.push({
              url,
              start: { x: prefix.index, y: rowOffset + row },
              end,
            })
          }
        } catch {}
      }

      prefix = HTTP_PREFIX.exec(lines[row])
    }
  }

  return matches
}

// Preserve printable text while removing escape/control sequences. This lets
// callers notice a complete URL sent by a TUI before cursor movement and
// repainting turn it into a clipped or fragmented screen representation.
export function stripTerminalControlSequences(text) {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001B[@-_]/gu, '')
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/gu, '')
}
