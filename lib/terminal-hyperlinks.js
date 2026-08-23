const OSC8_HTTP_URL = /\u001B\]8;[^;]*;(https?:\/\/.*?)(?:\u0007|\u001B\\)/gisu;

// OSC 8 links often use a short label (or print a separately truncated URL)
// while keeping the complete destination in terminal metadata.
export function extractOsc8HttpUrls(text) {
  const urls = [];
  OSC8_HTTP_URL.lastIndex = 0;
  let match = OSC8_HTTP_URL.exec(text);
  while (match) {
    try {
      const url = new URL(match[1]);
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.push(url.href);
    } catch {}
    match = OSC8_HTTP_URL.exec(text);
  }
  return urls;
}

// If a TUI renders only a prefix of an explicit OSC 8 target, make the visible
// prefix open that complete target. Candidates are newest-first.
export function completeTerminalUrl(value, candidates) {
  return candidates.find(candidate => candidate === value || candidate.startsWith(value)) || value;
}
