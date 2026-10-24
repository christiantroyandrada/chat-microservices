import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddNotificationInbox1792627200000 implements MigrationInterface {
  name = 'AddNotificationInbox1792627200000'

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE "notification_inbox" (
      "eventKey" text PRIMARY KEY,
      "canonical" jsonb NOT NULL,
      "advisory" jsonb NOT NULL DEFAULT '{}',
      "receivedAt" timestamptz NOT NULL DEFAULT now()
    )`)
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE "notification_inbox"')
  }
}
