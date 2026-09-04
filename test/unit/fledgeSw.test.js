import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const workerSource = fs.readFileSync(new URL('../../frontend/public/fledge-sw.js', import.meta.url), 'utf8')

function workerHarness() {
  const listeners = new Map()
  const badgeCalls = []
  const notifications = []
  const self = {
    location: { origin: 'https://app.feather.plus' },
    addEventListener(type, listener) { listeners.set(type, listener) },
    skipWaiting() {},
    navigator: {
      async setAppBadge(count) { badgeCalls.push(['set', count]) },
      async clearAppBadge() { badgeCalls.push(['clear']) },
    },
    registration: {
      async showNotification(title, options) { notifications.push({ title, options }) },
    },
    clients: {
      async claim() {},
      async matchAll() { return [] },
      async openWindow() {},
    },
  }
  const caches = {
    async keys() { return [] },
    async delete() {},
    async open() { return { async put() {} } },
    async match() {},
  }
  vm.runInNewContext(workerSource, { self, caches, URL, Promise, Number })
  return { listeners, badgeCalls, notifications }
}

async function dispatchPush(harness, payload) {
  let completion
  harness.listeners.get('push')({
    data: { json: () => payload },
    waitUntil(promise) { completion = promise },
  })
  await completion
}

describe('Fledge service worker badges', () => {
  it('sets and clears the iOS app icon badge while keeping pushes visible', async () => {
    const harness = workerHarness()

    await dispatchPush(harness, { title: 'New reply', body: 'A thread changed.', badgeCount: 4 })
    await dispatchPush(harness, { title: 'Caught up', badgeCount: 0 })

    assert.deepEqual(harness.badgeCalls, [['set', 4], ['clear']])
    assert.equal(harness.notifications.length, 2)
    assert.equal(harness.notifications[0].title, 'New reply')
  })
})
