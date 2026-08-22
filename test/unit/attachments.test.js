import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractImages } from '../../frontend/src/lib/attachments.js'

describe('extractImages', () => {
  it('extracts attached image markers', () => {
    const { cleanText, images, files } = extractImages(
      'here you go\n[Attached image: /home/user/a.png]\n[Attached image: /home/user/b.png]',
    )
    assert.deepEqual(images, ['/home/user/a.png', '/home/user/b.png'])
    assert.deepEqual(files, [])
    assert.equal(cleanText, 'here you go')
  })

  it('extracts attached file markers with names', () => {
    const { cleanText, files } = extractImages('[Attached file: /tmp/report.pdf] (report.pdf) please review')
    assert.deepEqual(files, [{ path: '/tmp/report.pdf', name: 'report.pdf' }])
    assert.equal(cleanText, 'please review')
  })

  it('ignores markers quoted in inline code', () => {
    const text = 'Fixed: `[Attached image: /abs/path]` markers rendered raw `<img>` tags too.'
    const { cleanText, images, files } = extractImages(text)
    assert.deepEqual(images, [])
    assert.deepEqual(files, [])
    assert.equal(cleanText, text)
  })

  it('ignores markers quoted in fenced code blocks', () => {
    const text = 'example:\n```\n[Attached image: /home/user/x.png]\n[Attached file: /tmp/y.pdf] (y.pdf)\n```'
    const { cleanText, images, files } = extractImages(text)
    assert.deepEqual(images, [])
    assert.deepEqual(files, [])
    assert.equal(cleanText, text)
  })

  it('extracts real markers while leaving quoted ones alone', () => {
    const text = 'See `[Attached image: /quoted/one.png]` for syntax.\n[Attached image: /real/two.png]'
    const { cleanText, images } = extractImages(text)
    assert.deepEqual(images, ['/real/two.png'])
    assert.ok(cleanText.includes('`[Attached image: /quoted/one.png]`'))
    assert.ok(!cleanText.includes('/real/two.png'))
  })

  it('handles an unterminated fence as code to the end', () => {
    const { images } = extractImages('```\n[Attached image: /x.png]')
    assert.deepEqual(images, [])
  })
})
