let repaintCount = 0

process.stdout.write('READY\n')
process.on('SIGWINCH', () => {
  repaintCount++
  let repaint = ''
  for (let index = 0; index < 12_000; index++) {
    repaint += `reflow-${String(index).padStart(5, '0')} xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n`
  }
  process.stdout.write(`${repaint}\u001b[2J\u001b[HFINAL ${process.stdout.columns}x${process.stdout.rows} winch=${repaintCount}\n`)
})

setInterval(() => {}, 10_000)
