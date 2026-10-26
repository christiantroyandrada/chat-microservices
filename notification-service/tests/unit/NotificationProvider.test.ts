import { EventEmitter } from 'node:events'
import { fork as nativeFork } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { NotificationProvider, validateProviderRequest } from '../../src/services/NotificationProvider'

jest.mock('node:child_process', () => ({ fork: jest.fn() }))
const fork = nativeFork as jest.MockedFunction<typeof nativeFork>
const actualFork = (jest.requireActual('node:child_process') as typeof import('node:child_process')).fork
const request = { provider: 'email', to: 'person@fixture.invalid', subject: 'Subject', html: '<p>Body</p>' } as const
const sent = { status: 'sent', attempt: 'started' } as const
function child() {
  return Object.assign(new EventEmitter(), { pid: 1234 as number | undefined, send: jest.fn(), kill: jest.fn(() => true) })
}
beforeEach(() => { jest.replaceProperty(process, 'env', { NODE_ENV: 'production' }); fork.mockReset() })
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks() })

test('validates the exact request schema and byte budget before fork', async () => {
  const provider = new NotificationProvider()
  for (const invalid of [null, [], {}, { ...request, env: {} }, { ...request, to: '' }, { ...request, html: '\u0000' }, { ...request, subject: '\ud800' }, { ...request, to: 'x'.repeat(321) }, { ...request, html: '世'.repeat(34000) }, { provider: 'push', token: 'x'.repeat(4097), message: 'hello' }, { provider: 'push', token: 'fixture', message: 'hello', envelope: 'x'.repeat(5001) }]) {
    await expect(provider.dispatch(invalid)).rejects.toThrow('Invalid notification provider request')
  }
  expect(fork).not.toHaveBeenCalled()
  expect(validateProviderRequest({ provider: 'push', token: 'fixture', message: 'café 世界 😀' })).toEqual({ provider: 'push', token: 'fixture', message: 'café 世界 😀' })
})

test('requires one valid result and normal exit; forks a fixed sibling with clean options', async () => {
  process.env.NODE_OPTIONS = '--require=/fake/preload'
  process.env.DATABASE_URL = 'fixture-database'
  process.env.JWT_SECRET = 'fixture-jwt'
  process.env.EMAIL_FROM = 'sender@fixture.invalid'
  const current = child()
  fork.mockReturnValue(current as unknown as ReturnType<typeof nativeFork>)
  const provider = new NotificationProvider()
  const pending = provider.dispatch(request)
  let settled = false
  void pending.then(() => { settled = true })
  expect(fork).toHaveBeenCalledWith(resolve(__dirname, '../../src/services/NotificationProviderChild.js'), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { NODE_ENV: 'production', EMAIL_FROM: 'sender@fixture.invalid' },
  })
  current.emit('message', sent)
  await Promise.resolve()
  expect(settled).toBe(false)
  current.emit('exit', 0, null)
  await expect(pending).resolves.toEqual(sent)
})

test('rejects accessor requests without executing their getters', async () => {
  const getter = jest.fn(() => 'email')
  const invalid = Object.defineProperty({ to: request.to, subject: request.subject, html: request.html }, 'provider', { enumerable: true, get: getter })
  await expect(new NotificationProvider().dispatch(invalid)).rejects.toThrow('Invalid notification provider request')
  expect(getter).not.toHaveBeenCalled()
  expect(fork).not.toHaveBeenCalled()
})

test('releases a failed spawn after close confirms there was no PID', async () => {
  jest.useFakeTimers()
  const failed = Object.assign(child(), { pid: undefined })
  fork.mockReturnValue(failed as unknown as ReturnType<typeof nativeFork>)
  const provider = new NotificationProvider()
  const pending = provider.dispatch(request)
  const outcome = pending.catch(error => ({ code: error.code }))
  failed.emit('error', new Error('fixture spawn unavailable'))
  failed.emit('close', -2, null)
  jest.advanceTimersByTime(16000)
  await expect(outcome).resolves.toEqual({ status: 'retry', attempt: 'unknown', reason: 'child_failed' })
})

test.each(['malformed', 'duplicate', 'abnormal', 'missing'] as const)('treats %s output as uncertain', async mode => {
  const current = child()
  fork.mockReturnValue(current as unknown as ReturnType<typeof nativeFork>)
  const pending = new NotificationProvider().dispatch(request)
  if (mode === 'malformed') current.emit('message', { ...sent, rawError: 'fixture-private' })
  if (mode === 'duplicate') { current.emit('message', sent); current.emit('message', sent) }
  if (mode === 'abnormal') current.emit('message', sent)
  current.emit('exit', mode === 'abnormal' ? 2 : 0, null)
  await expect(pending).resolves.toEqual({ status: 'retry', attempt: 'unknown', reason: mode === 'abnormal' ? 'child_failed' : 'protocol_error' })
})

test('kills a hanging child at 15 seconds and waits for confirmed exit', async () => {
  jest.useFakeTimers()
  const current = child()
  fork.mockReturnValue(current as unknown as ReturnType<typeof nativeFork>)
  const pending = new NotificationProvider().dispatch(request)
  current.emit('message', sent)
  jest.advanceTimersByTime(15000)
  expect(current.kill).toHaveBeenCalledWith('SIGKILL')
  current.emit('exit', null, 'SIGKILL')
  await expect(pending).resolves.toEqual({ status: 'retry', attempt: 'unknown', reason: 'timeout' })
})

test('unconfirmed termination is fatal, retains the slot, and blocks every later dispatch', async () => {
  jest.useFakeTimers()
  const current = child()
  fork.mockReturnValue(current as unknown as ReturnType<typeof nativeFork>)
  const provider = new NotificationProvider()
  const pending = provider.dispatch(request)
  const rejection = expect(pending).rejects.toMatchObject({ code: 'PROVIDER_TERMINATION_UNCONFIRMED' })
  jest.advanceTimersByTime(16000)
  await rejection
  await expect(provider.dispatch(request)).rejects.toMatchObject({ code: 'PROVIDER_TERMINATION_UNCONFIRMED' })
  expect(fork).toHaveBeenCalledTimes(1)
  current.emit('exit', null, 'SIGKILL')
  await expect(provider.dispatch(request)).rejects.toMatchObject({ code: 'PROVIDER_TERMINATION_UNCONFIRMED' })
})

test('rejects a third live child before fork and releases a confirmed slot', async () => {
  const first = child(), second = child(), third = child()
  fork.mockReturnValueOnce(first as unknown as ReturnType<typeof nativeFork>).mockReturnValueOnce(second as unknown as ReturnType<typeof nativeFork>).mockReturnValueOnce(third as unknown as ReturnType<typeof nativeFork>)
  const provider = new NotificationProvider()
  const a = provider.dispatch(request), b = provider.dispatch(request)
  await expect(provider.dispatch(request)).rejects.toMatchObject({ code: 'PROVIDER_CAPACITY' })
  expect(fork).toHaveBeenCalledTimes(2)
  first.emit('message', sent); first.emit('exit', 0, null)
  await a
  const c = provider.dispatch(request)
  for (const current of [second, third]) { current.emit('message', sent); current.emit('exit', 0, null) }
  await Promise.all([b, c])
})

describe('native child processes', () => {
  let compiled: string
  beforeAll(() => {
    compiled = mkdtempSync(resolve(__dirname, '../../.provider-fixture-'))
    for (const file of ['services/NotificationProvider', 'services/NotificationProviderChild', 'config/config']) {
      const target = join(compiled, 'src', `${file}.js`)
      mkdirSync(resolve(target, '..'), { recursive: true })
      writeFileSync(target, transpileModule(readFileSync(resolve(__dirname, '../../src', `${file}.ts`), 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020, esModuleInterop: true } }).outputText)
    }
  })
  afterAll(() => rmSync(compiled, { recursive: true, force: true }))

  test.each(['success', 'wait', 'crash', 'result-crash', 'malformed', 'duplicate', 'hang', 'result-hang'])('native %s observes result, exit, and deadline semantics', async mode => {
    const children: ReturnType<typeof nativeFork>[] = []
    fork.mockImplementation((_path, _args, options) => {
      const current = actualFork(resolve(__dirname, '../fixtures/notificationProviderChild.cjs'), [mode], { ...options, cwd: compiled, env: { NODE_ENV: 'production' } })
      children.push(current)
      return current
    })
    const pending = new NotificationProvider().dispatch(request)
    const current = children[0]
    const started = Date.now()
    const result = await pending
    if (mode === 'success' || mode === 'wait') {
      expect(result).toEqual(sent)
      if (mode === 'wait') expect(Date.now() - started).toBeGreaterThanOrEqual(80)
    } else expect(result).toMatchObject({ status: 'retry', attempt: 'unknown' })
    expect(current.exitCode !== null || current.signalCode !== null).toBe(true)
  }, 20000)

  test('compiled parent forks the compiled sibling with disabled configuration and no ambient dotenv', async () => {
    fork.mockImplementation((modulePath, args, options) => actualFork(modulePath, args, { ...options, cwd: compiled }))
    const { NotificationProvider: CompiledProvider } = require(join(compiled, 'src/services/NotificationProvider.js')) as typeof import('../../src/services/NotificationProvider')
    await expect(new CompiledProvider().dispatch(request)).resolves.toEqual({ status: 'deferred', attempt: 'not_started', reason: 'provider_disabled' })
    expect(fork.mock.calls[0][0]).toBe(join(compiled, 'src/services/NotificationProviderChild.js'))
  })

  test('native children enforce the two-child limit before another fork', async () => {
    fork.mockImplementation((_path, _args, options) => actualFork(resolve(__dirname, '../fixtures/notificationProviderChild.cjs'), ['wait'], { ...options, cwd: compiled, env: { NODE_ENV: 'production' } }))
    const provider = new NotificationProvider()
    const first = provider.dispatch(request), second = provider.dispatch(request)
    await expect(provider.dispatch(request)).rejects.toMatchObject({ code: 'PROVIDER_CAPACITY' })
    expect(fork).toHaveBeenCalledTimes(2)
    await expect(Promise.all([first, second])).resolves.toEqual([sent, sent])
  })

  test('native spawn failure closes without an exit and does not block dispatch', async () => {
    fork.mockImplementation((_path, _args, options) => actualFork(resolve(__dirname, '../fixtures/notificationProviderChild.cjs'), ['success'], { ...options, cwd: compiled, env: { NODE_ENV: 'production' }, execPath: '/fixture/does-not-exist' }))
    const provider = new NotificationProvider()
    await expect(provider.dispatch(request)).resolves.toEqual({ status: 'retry', attempt: 'unknown', reason: 'child_failed' })
    await expect(provider.dispatch(request)).resolves.toEqual({ status: 'retry', attempt: 'unknown', reason: 'child_failed' })
  })

  test('native unconfirmed termination blocks dispatch and retains the live process until explicit test cleanup', async () => {
    jest.useFakeTimers()
    let current!: ReturnType<typeof nativeFork>
    fork.mockImplementation((_path, _args, options) => {
      current = actualFork(resolve(__dirname, '../fixtures/notificationProviderChild.cjs'), ['hang'], { ...options, cwd: compiled, env: { NODE_ENV: 'production' } })
      return current
    })
    const provider = new NotificationProvider()
    const pending = provider.dispatch(request)
    const kill = current.kill.bind(current)
    await new Promise<void>(resolveSpawn => current.once('spawn', resolveSpawn))
    jest.spyOn(current, 'kill').mockReturnValue(true)
    try {
      const rejection = expect(pending).rejects.toMatchObject({ code: 'PROVIDER_TERMINATION_UNCONFIRMED' })
      jest.advanceTimersByTime(16000)
      await rejection
      expect(current.exitCode).toBeNull()
      expect(current.signalCode).toBeNull()
      await expect(provider.dispatch(request)).rejects.toMatchObject({ code: 'PROVIDER_TERMINATION_UNCONFIRMED' })
      expect(fork).toHaveBeenCalledTimes(1)
    } finally {
      const exited = new Promise(resolveExit => current.once('exit', resolveExit))
      kill('SIGKILL')
      await exited
    }
  })

  test('compiled child exits on parent disconnect before a request', async () => {
    const current = actualFork(join(compiled, 'src/services/NotificationProviderChild.js'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], cwd: compiled, env: { NODE_ENV: 'production' } })
    const exited = new Promise(resolveExit => current.once('exit', resolveExit))
    current.disconnect()
    await exited
    expect(current.exitCode).not.toBe(0)
  })

  test('compiled child enforces its own deadline without a parent request', async () => {
    const current = actualFork(join(compiled, 'src/services/NotificationProviderChild.js'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], cwd: compiled, env: { NODE_ENV: 'production' } })
    const started = Date.now()
    await new Promise(resolveExit => current.once('exit', resolveExit))
    expect(Date.now() - started).toBeGreaterThanOrEqual(14500)
    expect(Date.now() - started).toBeLessThan(17000)
    expect(current.exitCode).not.toBe(0)
  }, 20000)
})
