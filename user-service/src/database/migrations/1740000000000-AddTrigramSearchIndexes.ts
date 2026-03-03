import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Performance migration: adds pg_trgm GIN indexes for fast ILIKE user search.
 *
 * The user search endpoint uses: WHERE username ILIKE '%query%' OR email ILIKE '%query%'
 * Standard B-tree indexes cannot accelerate leading-wildcard ILIKE queries.
 * pg_trgm GIN indexes break strings into 3-character trigrams and allow Postgres
 * to use index scans for ILIKE '%...%' patterns — turning a sequential scan
 * into an index scan even at 1M+ users.
 */
export class AddTrigramSearchIndexes1740000000000 implements MigrationInterface {
  name = 'AddTrigramSearchIndexes1740000000000'
  // CONCURRENTLY cannot run inside a transaction — disable the default wrapper
  transaction = false

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enable pg_trgm extension (no-op if already installed)
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')

    // GIN trigram indexes for fast ILIKE user search
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_users_username_trgm"
      ON "users" USING gin ("username" gin_trgm_ops)
    `)
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_users_email_trgm"
      ON "users" USING gin ("email" gin_trgm_ops)
    `)

    console.log('✅ Created pg_trgm GIN indexes on users.username and users.email')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_users_username_trgm"')
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_users_email_trgm"')
  }
}
