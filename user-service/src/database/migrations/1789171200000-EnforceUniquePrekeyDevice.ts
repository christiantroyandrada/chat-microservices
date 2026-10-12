import { MigrationInterface, QueryRunner } from 'typeorm'

const INDEX_NAME = 'IDX_prekeys_user_device'
const PUBLIC_FIELDS = ['identityKey', 'registrationId', 'signedPreKey', 'preKeys'] as const
const KNOWN_FIELDS = [...PUBLIC_FIELDS, '_encryptedKeyBundle'] as const

type DuplicateRow = {
  id: string
  userId: string
  deviceId: string
  latestRank: string
  backupRank: string
  bundleType: string | null
  identityType: string | null
  registrationType: string | null
  signedType: string | null
  signedIdType: string | null
  signedPublicKeyType: string | null
  signedSignatureType: string | null
  preKeysType: string | null
  preKeysValid: boolean
  backupType: string | null
}

function validateRow(row: DuplicateRow): { publicComplete: boolean; backupPresent: boolean } {
  const publicTypes = [row.identityType, row.registrationType, row.signedType, row.preKeysType]
  const present = publicTypes.map(type => type !== null)
  if (present.some(Boolean) && !present.every(Boolean)) throw new Error(`Malformed prekey bundle for duplicate row ${row.id}`)
  const publicComplete = present.every(Boolean)
  if (
    row.bundleType !== 'object' ||
    (publicComplete && (
      row.identityType !== 'string' ||
      row.registrationType !== 'number' ||
      row.signedType !== 'object' ||
      row.signedIdType !== 'number' ||
      row.signedPublicKeyType !== 'string' ||
      row.signedSignatureType !== 'string' ||
      row.preKeysType !== 'array' ||
      !row.preKeysValid
    )) ||
    (row.backupType !== null && row.backupType !== 'object')
  ) {
    throw new Error(`Malformed prekey bundle for duplicate row ${row.id}`)
  }
  return { publicComplete, backupPresent: row.backupType === 'object' }
}

export class EnforceUniquePrekeyDevice1789171200000 implements MigrationInterface {
  name = 'EnforceUniquePrekeyDevice1789171200000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('LOCK TABLE "prekeys" IN ACCESS EXCLUSIVE MODE')
    const duplicates: DuplicateRow[] = await queryRunner.query(`
      SELECT p."id", p."userId", p."deviceId",
        ROW_NUMBER() OVER (
          PARTITION BY p."userId", p."deviceId"
          ORDER BY p."updatedAt" DESC, p."createdAt" DESC, p."id" DESC
        ) AS "latestRank",
        ROW_NUMBER() OVER (
          PARTITION BY p."userId", p."deviceId"
          ORDER BY p."lastBackupTimestamp" DESC NULLS LAST, p."updatedAt" DESC, p."createdAt" DESC, p."id" DESC
        ) AS "backupRank",
        json_typeof(p."bundle") AS "bundleType",
        json_typeof(p."bundle"->'identityKey') AS "identityType",
        json_typeof(p."bundle"->'registrationId') AS "registrationType",
        json_typeof(p."bundle"->'signedPreKey') AS "signedType",
        json_typeof(p."bundle"->'signedPreKey'->'id') AS "signedIdType",
        json_typeof(p."bundle"->'signedPreKey'->'publicKey') AS "signedPublicKeyType",
        json_typeof(p."bundle"->'signedPreKey'->'signature') AS "signedSignatureType",
        json_typeof(p."bundle"->'preKeys') AS "preKeysType",
        CASE WHEN json_typeof(p."bundle"->'preKeys') = 'array' THEN NOT EXISTS (
          SELECT 1 FROM json_array_elements(p."bundle"->'preKeys') item
          WHERE json_typeof(item) IS DISTINCT FROM 'object'
             OR json_typeof(item->'id') IS DISTINCT FROM 'number'
             OR json_typeof(item->'publicKey') IS DISTINCT FROM 'string'
        ) ELSE false END AS "preKeysValid",
        json_typeof(p."bundle"->'_encryptedKeyBundle') AS "backupType"
      FROM "prekeys" p
      JOIN (
        SELECT "userId", "deviceId"
        FROM "prekeys"
        GROUP BY "userId", "deviceId"
        HAVING COUNT(*) > 1
      ) d ON d."userId" = p."userId" AND d."deviceId" = p."deviceId"
      ORDER BY p."userId", p."deviceId", "latestRank" DESC
    `)

    for (let start = 0; start < duplicates.length;) {
      let end = start + 1
      while (
        end < duplicates.length &&
        duplicates[end].userId === duplicates[start].userId &&
        duplicates[end].deviceId === duplicates[start].deviceId
      ) end++

      const group = duplicates.slice(start, end)
      const metadata = group.map(row => ({ row, ...validateRow(row) }))
      const keeper = group.find(row => row.latestRank === '1')!
      const publicSource = metadata.slice().reverse().find(({ publicComplete }) => publicComplete)?.row
      const backupSource = metadata
        .filter(({ backupPresent }) => backupPresent)
        .sort((left, right) => Number(left.row.backupRank) - Number(right.row.backupRank))[0]

      await queryRunner.query(
        `WITH source_rows AS (
           SELECT source."id", source."bundle",
             ROW_NUMBER() OVER (ORDER BY source."updatedAt", source."createdAt", source."id") AS source_order
           FROM "prekeys" source
           WHERE source."userId" = $1 AND source."deviceId" = $2
         ), latest_unknown AS (
           SELECT entry.key, MAX(source.source_order) AS source_order
           FROM source_rows source
           CROSS JOIN LATERAL json_each(source."bundle") WITH ORDINALITY entry(key, value, ordinality)
           WHERE NOT (entry.key = ANY($6::text[]))
           GROUP BY entry.key
         ), merged_entries AS (
           SELECT entry.key, entry.value, 0 AS section, source.source_order, entry.ordinality
           FROM source_rows source
           CROSS JOIN LATERAL json_each(source."bundle") WITH ORDINALITY entry(key, value, ordinality)
           JOIN latest_unknown latest ON latest.key = entry.key AND latest.source_order = source.source_order
           WHERE NOT (entry.key = ANY($6::text[]))
           UNION ALL
           SELECT entry.key, entry.value, 1, 0, entry.ordinality
           FROM source_rows source
           CROSS JOIN LATERAL json_each(source."bundle") WITH ORDINALITY entry(key, value, ordinality)
           WHERE source."id" = $4::uuid AND entry.key = ANY($7::text[])
           UNION ALL
           SELECT entry.key, entry.value, 2, 0, entry.ordinality
           FROM source_rows source
           CROSS JOIN LATERAL json_each(source."bundle") WITH ORDINALITY entry(key, value, ordinality)
           WHERE source."id" = $5::uuid AND entry.key = '_encryptedKeyBundle'
         ), merged_bundle AS (
           SELECT COALESCE(
             json_object_agg(key, value ORDER BY section, source_order, ordinality),
             '{}'::json
           ) AS value
           FROM merged_entries
         )
         UPDATE "prekeys" keeper
         SET "bundle" = merged_bundle.value,
             "lastBackupTimestamp" = (
               SELECT MAX(source."lastBackupTimestamp")
               FROM "prekeys" source
               WHERE source."userId" = $1 AND source."deviceId" = $2
             )
         FROM merged_bundle
         WHERE keeper."id" = $3`,
        [
          keeper.userId,
          keeper.deviceId,
          keeper.id,
          publicSource?.id ?? null,
          backupSource?.row.id ?? null,
          [...KNOWN_FIELDS],
          [...PUBLIC_FIELDS],
        ],
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
