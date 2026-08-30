import { render } from 'solid-js/web'
import App from './App'

const root = document.getElementById('root')!
try {
  render(() => <App />, root)
} catch (error: unknown) {
  root.textContent = `BOOT ERROR: ${error instanceof Error ? error.stack || error.message : String(error)}`
}
