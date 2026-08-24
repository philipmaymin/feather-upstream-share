import { execFile } from 'child_process';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function runTmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function tmuxStatusRows(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'off' || normalized === '0') return 0;
  if (/^[2-5]$/.test(normalized)) return Number(normalized);
  return 1;
}

export function parseTmuxPaneGeometry(value) {
  const [width, height, history] = String(value || '').trim().split('|').map(Number);
  if (![width, height, history].every(Number.isFinite)) return null;
  return { width, height, history };
}

// A tmux client's rows include its status line, while pane_height does not.
// Resize a detached pane first so a full-screen app can finish its SIGWINCH
// repaint into tmux's history instead of streaming that repaint to the phone.
export async function prepareTmuxTerminal(name, cols, rows, options = {}) {
  const run = options.runTmux || runTmux;
  const sleep = options.sleep || wait;
  const now = options.now || Date.now;
  const pollMs = options.pollMs ?? 40;
  const quietMs = options.quietMs ?? 180;
  const minimumWaitMs = options.minimumWaitMs ?? 240;
  const maximumWaitMs = options.maximumWaitMs ?? 1_200;
  const geometryArgs = ['display-message', '-p', '-t', name, '#{pane_width}|#{pane_height}|#{history_size}'];

  let status = 'on';
  try { status = await run(['show-options', '-gv', '-t', name, 'status']); } catch {}
  const target = {
    width: cols,
    height: Math.max(1, rows - tmuxStatusRows(status)),
  };
  const initial = parseTmuxPaneGeometry(await run(geometryArgs));
  if (initial?.width === target.width && initial.height === target.height) {
    return { resized: false, settled: true, target, elapsedMs: 0 };
  }

  await run(['resize-window', '-t', name, '-x', String(target.width), '-y', String(target.height)]);
  const startedAt = now();
  let lastHistory = null;
  let quietSince = startedAt;
  let current = initial;

  while (now() - startedAt < maximumWaitMs) {
    current = parseTmuxPaneGeometry(await run(geometryArgs));
    const sampledAt = now();
    if (current?.history !== lastHistory) {
      lastHistory = current?.history ?? null;
      quietSince = sampledAt;
    }
    const hasTargetSize = current?.width === target.width && current.height === target.height;
    if (hasTargetSize
      && sampledAt - startedAt >= minimumWaitMs
      && sampledAt - quietSince >= quietMs) {
      return { resized: true, settled: true, target, elapsedMs: sampledAt - startedAt };
    }
    await sleep(pollMs);
  }

  return { resized: true, settled: false, target, elapsedMs: now() - startedAt };
}
