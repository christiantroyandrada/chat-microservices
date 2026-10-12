import { MigrationInterface, QueryRunner } from 'typeorm'

const MESSAGE_KEY_INDEX = 'IDX_messages_sender_client_message'
const OUTBOX_INDEX = 'IDX_outbox_events_state_available_at'

export class AddMessageIdempotencyOutbox1789171201000 implements MigrationInterface {
  name = 'AddMessageIdempotencyOutbox1789171201000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "messages" ADD COLUMN "clientMessageId" uuid')
    await queryRunner.query(`
      CREATE UNIQUE INDEX "${MESSAGE_KEY_INDEX}"
      ON "messages" ("senderId", "clientMessageId")
      WHERE "clientMessageId" IS NOT NULL
    `)
    await queryRunner.query(`CREATE TYPE "outbox_event_state_enum" AS ENUM ('pending', 'leased', 'published')`)
    await queryRunner.query(`
      CREATE TABLE "outbox_events" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "payload" jsonb NOT NULL,
        "state" "outbox_event_state_enum" NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT 0,
        "availableAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "lockedAt" timestamptz,
        "leaseToken" uuid,
        "lastError" text,
        "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await queryRunner.query(`
      CREATE INDEX "${OUTBOX_INDEX}" ON "outbox_events" ("state", "availableAt")
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "outbox_events"')
    await queryRunner.query('DROP TYPE "outbox_event_state_enum"')
    await queryRunner.query(`DROP INDEX "${MESSAGE_KEY_INDEX}"`)
    await queryRunner.query('ALTER TABLE "messages" DROP COLUMN "clientMessageId"')
  }
}
