import { defineConfig } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import { readFileSync } from 'fs'

const buildVersion = (() => {
  try { return String(JSON.parse(readFileSync('../version.json', 'utf8')).version || '') }
  catch { return '' }
})()
const version = (() => {
  const d = new Date(buildVersion || Date.now())
  return d.toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
})()


export default defineConfig({
  plugins: [solidPlugin()],
  define: {
    __BUILD_TIME__: JSON.stringify(version),
    __BUILD_VERSION__: JSON.stringify(buildVersion),
  },
  base: './',
  build: {
    // DEPLOY PROTOCOL: builds go here (static-test), NOT static/ or static-staging/.
    // After building: run Playwright tests, then cp to static-staging/.
    // NEVER cp directly to static/ -- users get updates via the "Update Available" button.
    outDir: process.env.REFEATHER_RELEASE_BUILD === '1' ? '../static' : '../static-test',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 5174,
    proxy: {
      '/new-dev/api': {
        target: 'http://localhost:4870',
        rewrite: (path) => path.replace(/^\/new-dev/, ''),
      },
    },
  },
})
