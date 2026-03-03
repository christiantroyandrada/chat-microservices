import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Performance migration: adds indexes that dramatically speed up the most
 * common hot-path queries in the chat-service.
 *
 * 1. Partial index on unread messages — speeds up the unread-count sub-query
 *    in getConversations (avoids scanning all messages for status != 'Seen').
 * 2. Covering indexes for the conversation CTE's ORDER BY + PARTITION BY —
 *    lets Postgres satisfy the window function with an index-only scan.
 */
export class AddPerformanceIndexes1740000000000 implements MigrationInterface {
  name = 'AddPerformanceIndexes1740000000000'
  // CONCURRENTLY cannot run inside a transaction — disable the default wrapper
  transaction = false

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Partial index for unread message counts
    //    The getConversations CTE filters: WHERE "receiverId" = $1 AND status != 'Seen'
    //    GROUP BY "senderId" — this index covers that exact query shape.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_messages_unread"
      ON "messages" ("receiverId", "senderId")
      WHERE status != 'Seen'
    `)

    // 2. Covering indexes for the conversation CTE window function
    //    PARTITION BY (senderId/receiverId) ORDER BY "createdAt" DESC
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_messages_sender_created_desc"
      ON "messages" ("senderId", "createdAt" DESC)
    `)
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_messages_receiver_created_desc"
      ON "messages" ("receiverId", "createdAt" DESC)
    `)

    // 3. Composite index for the unread status filter in markAsRead
    //    WHERE senderId = ? AND receiverId = ? AND status != 'Seen'
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_messages_receiver_status"
      ON "messages" ("receiverId", "status")
    `)

    console.log('✅ Created performance indexes for messages table')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_messages_unread"')
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_messages_sender_created_desc"')
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_messages_receiver_created_desc"')
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_messages_receiver_status"')
  }
}
