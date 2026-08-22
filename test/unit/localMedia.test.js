import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { localFilePath, localFileUrl } from '../../frontend/src/lib/localMedia.js'

describe('localFilePath', () => {
  it('accepts absolute filesystem paths', () => {
    assert.equal(
      localFilePath('/home/user/rooms/family/chart.png'),
      '/home/user/rooms/family/chart.png',
    )
  })

  it('accepts home-relative and file:// forms', () => {
    assert.equal(localFilePath('~/plots/chart.png'), '~/plots/chart.png')
    assert.equal(localFilePath('file:///tmp/shot.png'), '/tmp/shot.png')
  })

  it('decodes percent-encoded paths', () => {
    assert.equal(localFilePath('/home/user/My%20Charts/a.png'), '/home/user/My Charts/a.png')
  })

  it('rejects web URLs and data/blob URIs', () => {
    assert.equal(localFilePath('https://example.com/a.png'), null)
    assert.equal(localFilePath('http://example.com/a.png'), null)
    assert.equal(localFilePath('data:image/png;base64,AAAA'), null)
    assert.equal(localFilePath('blob:https://example.com/x'), null)
    assert.equal(localFilePath('mailto:a@b.com'), null)
  })

  it('rejects relative paths and empty values', () => {
    assert.equal(localFilePath('chart.png'), null)
    assert.equal(localFilePath('images/chart.png'), null)
    assert.equal(localFilePath(''), null)
    assert.equal(localFilePath(null), null)
    assert.equal(localFilePath(undefined), null)
  })

  it('leaves app-served routes alone', () => {
    assert.equal(localFilePath('/uploads/123-pasted-image.png'), null)
    assert.equal(localFilePath('/api/files/raw?path=%2Ftmp%2Fx.png'), null)
    assert.equal(localFilePath('/assets/index.js'), null)
    assert.equal(localFilePath('/static/icon-192.png'), null)
    assert.equal(localFilePath('/feather2/api/file?path=%2Ftmp%2Fx.png', '/feather2/'), null)
  })
})

describe('localFileUrl', () => {
  it('routes local paths through the Files raw preview with encoding', () => {
    assert.equal(
      localFileUrl('/home/user/rooms/family/chart.png'),
      '/api/files/raw?path=%2Fhome%2Fuser%2Frooms%2Ffamily%2Fchart.png',
    )
  })

  it('preserves a mounted application prefix', () => {
    assert.equal(
      localFileUrl('/tmp/chart.png', '/feather2/'),
      '/feather2/api/files/raw?path=%2Ftmp%2Fchart.png',
    )
  })

  it('returns null for non-local references', () => {
    assert.equal(localFileUrl('https://example.com/a.png'), null)
    assert.equal(localFileUrl('/uploads/x.png'), null)
  })
})
