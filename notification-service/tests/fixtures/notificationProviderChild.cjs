const mode = process.argv[2]
process.once('message', () => {
  const sent = { status: 'sent', attempt: 'started' }
  if (mode === 'crash') return process.exit(2)
  if (mode === 'malformed') return process.send({ ...sent, rawError: 'fixture-private' }, () => process.exit(0))
  if (mode === 'hang') return setInterval(() => {}, 1000)
  process.send(sent, () => {
    if (mode === 'duplicate') return process.send(sent, () => process.exit(0))
    if (mode === 'result-crash') return process.exit(2)
    if (mode === 'result-hang') return setInterval(() => {}, 1000)
    if (mode === 'wait') return setTimeout(() => process.exit(0), 100)
    process.exit(0)
  })
})
