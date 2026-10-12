import { MigrationInterface, QueryRunner } from 'typeorm'

const INDEX_NAME = 'IDX_prekeys_user_device'
const PUBLIC_FIELDS = ['identityKey', 'registrationId', 'signedPreKey', 'preKeys'] as const
const KNOWN_FIELDS = new Set<string>([...PUBLIC_FIELDS, '_encryptedKeyBundle'])

type DuplicateRow = {
  id: string
  userId: string
  deviceId: string
  bundle: unknown
  backupRank: string
}

const owns = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function validatedBundle(row: DuplicateRow): Record<string, unknown> {
  if (!isObject(row.bundle)) throw new Error(`Malformed prekey bundle for duplicate row ${row.id}`)

  const present = PUBLIC_FIELDS.map(field => owns(row.bundle as Record<string, unknown>, field))
  if (present.some(Boolean) && !present.every(Boolean)) throw new Error(`Malformed prekey bundle for duplicate row ${row.id}`)

  if (present.every(Boolean)) {
    const signed = row.bundle.signedPreKey
    const preKeys = row.bundle.preKeys
    if (
      typeof row.bundle.identityKey !== 'string' ||
      typeof row.bundle.registrationId !== 'number' ||
      !isObject(signed) ||
      typeof signed.id !== 'number' ||
      typeof signed.publicKey !== 'string' ||
      typeof signed.signature !== 'string' ||
      !Array.isArray(preKeys) ||
      !preKeys.every(key => isObject(key) && typeof key.id === 'number' && typeof key.publicKey === 'string')
    ) {
      throw new Error(`Malformed prekey bundle for duplicate row ${row.id}`)
    }
  }

  if (owns(row.bundle, '_encryptedKeyBundle') && !isObject(row.bundle._encryptedKeyBundle)) {
    throw new Error(`Malformed prekey bundle for duplicate row ${row.id}`)
  }
  return row.bundle
}

export class EnforceUniquePrekeyDevice1789171200000 implements MigrationInterface {
  name = 'EnforceUniquePrekeyDevice1789171200000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('LOCK TABLE "prekeys" IN ACCESS EXCLUSIVE MODE')
    const duplicates: DuplicateRow[] = await queryRunner.query(`
      SELECT p.*,
        ROW_NUMBER() OVER (
          PARTITION BY p."userId", p."deviceId"
          ORDER BY p."lastBackupTimestamp" DESC NULLS LAST, p."updatedAt" DESC, p."createdAt" DESC, p."id" DESC
        ) AS "backupRank"
      FROM "prekeys" p
      JOIN (
        SELECT "userId", "deviceId"
        FROM "prekeys"
        GROUP BY "userId", "deviceId"
        HAVING COUNT(*) > 1
      ) d ON d."userId" = p."userId" AND d."deviceId" = p."deviceId"
      ORDER BY p."userId", p."deviceId", p."updatedAt", p."createdAt", p."id"
    `)

    for (let start = 0; start < duplicates.length;) {
      let end = start + 1
      while (
        end < duplicates.length &&
        duplicates[end].userId === duplicates[start].userId &&
        duplicates[end].deviceId === duplicates[start].deviceId
      ) end++

      const group = duplicates.slice(start, end)
      const bundles = group.map(validatedBundle)
      const keeper = group[group.length - 1]
      const merged: Record<string, unknown> = Object.create(null)

      for (const bundle of bundles) {
        for (const [key, value] of Object.entries(bundle)) {
          if (!KNOWN_FIELDS.has(key)) merged[key] = value
        }
      }

      for (let index = group.length - 1; index >= 0; index--) {
        if (PUBLIC_FIELDS.every(field => owns(bundles[index], field))) {
          for (const field of PUBLIC_FIELDS) merged[field] = bundles[index][field]
          break
        }
      }

      const backupSource = group
        .map((row, index) => ({ row, bundle: bundles[index] }))
        .filter(({ bundle }) => owns(bundle, '_encryptedKeyBundle'))
        .sort((left, right) => Number(left.row.backupRank) - Number(right.row.backupRank))[0]
      if (backupSource) merged._encryptedKeyBundle = backupSource.bundle._encryptedKeyBundle

      await queryRunner.query(
        `UPDATE "prekeys" keeper
         SET "bundle" = $1::json,
             "lastBackupTimestamp" = (
               SELECT MAX(source."lastBackupTimestamp")
               FROM "prekeys" source
               WHERE source."userId" = $2 AND source."deviceId" = $3
             )
         WHERE keeper."id" = $4`,
        [JSON.stringify(merged), keeper.userId, keeper.deviceId, keeper.id],
      )
      await queryRunner.query(
        'DELETE FROM "prekeys" WHERE "userId" = $1 AND "deviceId" = $2 AND "id" <> $3',
        [keeper.userId, keeper.deviceId, keeper.id],
      )
      start = end
    }

    await queryRunner.query(`CREATE UNIQUE INDEX "${INDEX_NAME}" ON "prekeys" ("userId", "deviceId")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "${INDEX_NAME}"`)
  }
}
