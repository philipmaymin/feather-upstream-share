// Extraction of upload markers ([Attached image: /path], [Attached file: /path] (name))
// from message text. Markers inside Markdown code — fenced blocks or inline
// spans — are quoted text, not real attachments, and are left alone.

const imgPattern = /\[Attached image: (\/[^\]]+)\]/g

const filePattern = /\[Attached file: (\/[^\]]+)\]\s*\(([^)]+)\)/g

function codeRanges(text) {
  const ranges = []
  for (const re of [/```[\s\S]*?(?:```|$)/g, /`[^`\n]*`/g]) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0
      if (!ranges.some(([s, e]) => start >= s && start < e)) ranges.push([start, start + m[0].length])
    }
  }
  return ranges
}

export function extractImages(text) {
  const images = []
  const files = []
  const outsideCode = (ranges, offset) => !ranges.some(([s, e]) => offset >= s && offset < e)
  const imgRanges = codeRanges(text)
  let cleaned = text.replace(imgPattern, (match, p, offset) => {
    if (!outsideCode(imgRanges, offset)) return match
    images.push(p); return ''
  })
  const fileRanges = codeRanges(cleaned)
  cleaned = cleaned.replace(filePattern, (match, p, name, offset) => {
    if (!outsideCode(fileRanges, offset)) return match
    files.push({ path: p, name }); return ''
  }).trim()
  return { cleanText: cleaned, images, files }
}
