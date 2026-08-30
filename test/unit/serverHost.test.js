import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '../..')
const roots = []
const children = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM')
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function start(host) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-host-'))
  roots.push(root)
  const home = path.join(root, 'home')
  const state = path.join(root, 'state')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(home)
  fs.mkdirSync(state)
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  const port = await freePort()
  const env = {
    ...process.env,
    HOME: home,
    FEATHER_STATE_DIR: state,
    FEATHER_PUSH_POLL: '0',
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    PORT: String(port),
  }
  if (host) env.HOST = host
  else delete env.HOST
  const child = spawn(process.execPath, ['server-single.js'], {
    cwd: repo,
    env,
    stdio: 'ignore',
  })
  children.push(child)
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok) return { port }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('server did not start')
}

function externalIpv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) if (entry.family === 'IPv4' && !entry.internal) return entry.address
  }
  return null
}

describe('server host binding', () => {
  it('defaults to loopback while preserving an explicit wildcard override', async () => {
    const address = externalIpv4()
    const local = await start()
    if (address) {
      await assert.rejects(fetch(`http://${address}:${local.port}/api/health`, { signal: AbortSignal.timeout(500) }))
    }
    for (const child of children.splice(0)) {
      if (child.exitCode === null) child.kill('SIGTERM')
      await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
    }
    const exposed = await start('0.0.0.0')
    if (address) {
      const response = await fetch(`http://${address}:${exposed.port}/api/health`, { signal: AbortSignal.timeout(1000) })
      assert.equal(response.status, 200)
    }
  })
})
