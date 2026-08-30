// `node --test test/unit/` on this Node (22.x) executes the directory as a
// single entry module instead of globbing it, so this index imports every
// sibling *.test.js to register all suites with the runner. On Nodes that do
// glob directories, index.js doesn't match the test-file pattern and is inert.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
for (const f of fs.readdirSync(dir).sort()) {
  if (f.endsWith('.test.js')) await import(path.join(dir, f))
}
