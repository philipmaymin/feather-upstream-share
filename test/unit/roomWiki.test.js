import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validWikiPageName, listWikiPages, readWikiPage, verifiedWikiRoot } from '../../lib/room-wiki.js'

describe('room wiki', () => {
  let root, wiki, outside

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-wiki-'))
    wiki = path.join(root, 'room', 'wiki')
    outside = path.join(root, 'secret.md')
    fs.mkdirSync(path.join(wiki, 'Operations'), { recursive: true })
    fs.mkdirSync(path.join(wiki, '_assets'))
    fs.writeFileSync(path.join(wiki, 'Home.md'), '# Home\n[Rooms](Rooms.md)\n')
    fs.writeFileSync(path.join(wiki, 'Rooms.md'), '# Rooms\n')
    fs.writeFileSync(path.join(wiki, 'Operations', 'Deploy.md'), '# Deploy\n')
    fs.writeFileSync(path.join(wiki, '_assets', 'ignored.md'), 'asset\n')
    fs.writeFileSync(path.join(wiki, 'notes.txt'), 'not a page\n')
    fs.writeFileSync(path.join(wiki, 'Bad..md'), 'invalid page name\n')
    fs.writeFileSync(path.join(wiki, 'Oversized.md'), Buffer.alloc(1024 * 1024 + 1))
    fs.writeFileSync(outside, 'must never be served\n')
    fs.symlinkSync(outside, path.join(wiki, 'Escape.md'))
  })

  after(() => fs.rmSync(root, { recursive: true, force: true }))

  it('validates page names: segments only, no traversal or hidden entries', () => {
    assert.equal(validWikiPageName('Home'), true)
    assert.equal(validWikiPageName('Operations/Deploy'), true)
    assert.equal(validWikiPageName('Zak repair 2026'), true)
    assert.equal(validWikiPageName('../notes'), false)
    assert.equal(validWikiPageName('a/../../b'), false)
    assert.equal(validWikiPageName('.hidden'), false)
    assert.equal(validWikiPageName('_assets/x'), false)
    assert.equal(validWikiPageName('/abs'), false)
    assert.equal(validWikiPageName(''), false)
    assert.equal(validWikiPageName('a/b/c/d/e'), false) // depth cap
    assert.equal(validWikiPageName('trailing.'), false)
  })

  it('lists .md pages recursively, Home first, skipping hidden/underscore/non-md', () => {
    const names = listWikiPages(wiki).map((p) => p.name)
    assert.deepEqual(names, ['Home', 'Operations/Deploy', 'Rooms'])
  })

  it('lists nothing for a room without a wiki', () => {
    assert.deepEqual(listWikiPages(path.join(root, 'nope', 'wiki')), [])
  })

  it('verifies the exact non-symlinked Room wiki root', () => {
    assert.equal(verifiedWikiRoot(root, 'room'), fs.realpathSync(wiki))
    const linkedWikiRoom = path.join(root, 'linked-wiki')
    fs.mkdirSync(linkedWikiRoom)
    fs.symlinkSync('../room/wiki', path.join(linkedWikiRoom, 'wiki'))
    assert.equal(verifiedWikiRoot(root, 'linked-wiki'), null)
    assert.deepEqual(listWikiPages(path.join(linkedWikiRoom, 'wiki')), [])

    fs.symlinkSync('room', path.join(root, 'linked-room'))
    assert.equal(verifiedWikiRoot(root, 'linked-room'), null)
  })

  it('reads a page with content and mtime', () => {
    const page = readWikiPage(wiki, 'Operations/Deploy')
    assert.equal(page.name, 'Operations/Deploy')
    assert.equal(page.content, '# Deploy\n')
    assert.ok(page.updatedAt)
  })

  it('refuses traversal, symlink escapes, and non-pages', () => {
    assert.equal(readWikiPage(wiki, '../room/wiki/Home'), null)
    assert.equal(readWikiPage(wiki, 'Escape'), null) // symlink out of the wiki root
    assert.equal(readWikiPage(wiki, 'notes'), null)  // .txt is not a page
    assert.equal(readWikiPage(wiki, 'Missing'), null)
  })
})
