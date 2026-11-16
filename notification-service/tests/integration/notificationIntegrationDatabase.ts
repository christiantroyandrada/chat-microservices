import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import type { DataSource } from 'typeorm'

const role = 'notification_fixture'

export function requireNotificationIntegrationDatabase(env: NodeJS.ProcessEnv) {
  const url = env.NOTIFICATION_INTEGRATION_DATABASE_URL ?? ''
  const containerId = env.NOTIFICATION_INTEGRATION_CONTAINER_ID ?? ''
  const match = /^postgresql:\/\/notification_fixture@127\.0\.0\.1:([1-9][0-9]{0,4})\/(notification_integration_[a-z0-9_]{1,38})$/.exec(url)
  assert.ok(match && Number(match[1]) <= 65535, 'An isolated notification database URL is required')
  assert.match(containerId, /^[a-f0-9]{64}$/, 'An isolated notification container ID is required')
  const [, port, database] = match

  function docker(args: string[]): string {
    return execFileSync('/opt/homebrew/bin/docker', ['--context', 'colima', ...args], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim()
  }

  function verifyContainer() {
    const [container] = JSON.parse(docker(['container', 'inspect', containerId]))
    assert.equal(container.Id, containerId)
    assert.equal(container.State.Running, true)
    assert.equal(container.Config.Labels?.['chat.fixture'], database)
    assert.deepEqual(container.HostConfig.Tmpfs, { '/var/lib/postgresql/data': 'rw' })
    assert.deepEqual(container.Mounts, [])
    assert.deepEqual(container.NetworkSettings.Ports, { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: port }] })
  }

  verifyContainer()
  const system = docker([
    'exec', containerId, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', role, '-d', database,
    '-c', 'SELECT system_identifier FROM pg_control_system()',
  ])
  assert.match(system, /^\d+$/)

  return {
    url,
    async assertIdentity(source: DataSource) {
      verifyContainer()
      const [identity] = await source.query(
        'SELECT current_database() AS database, current_user AS role, inet_server_port() AS port, system_identifier::text AS system FROM pg_control_system()',
      )
      assert.deepEqual(identity, { database, role, port: 5432, system })
    },
  }
}
