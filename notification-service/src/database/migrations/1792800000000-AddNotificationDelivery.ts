import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddNotificationDelivery1792800000000 implements MigrationInterface {
  name = 'AddNotificationDelivery1792800000000'

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE notification_inbox
      ADD COLUMN "emailState" text NOT NULL DEFAULT 'pending' CHECK ("emailState" IN ('pending', 'retry', 'deferred', 'sent', 'failed', 'skipped')),
      ADD COLUMN "pushState" text NOT NULL DEFAULT 'pending' CHECK ("pushState" IN ('pending', 'retry', 'deferred', 'sent', 'failed', 'skipped')),
      ADD COLUMN "emailAttempts" integer NOT NULL DEFAULT 0 CHECK ("emailAttempts" BETWEEN 0 AND 8),
      ADD COLUMN "pushAttempts" integer NOT NULL DEFAULT 0 CHECK ("pushAttempts" BETWEEN 0 AND 8),
      ADD COLUMN "emailAvailableAt" timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN "pushAvailableAt" timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN "emailReason" varchar(64),
      ADD COLUMN "pushReason" varchar(64),
      ADD COLUMN "deliveryLeaseToken" uuid,
      ADD COLUMN "deliveryLockedAt" timestamptz,
      ADD CONSTRAINT "CHK_notification_delivery_lease" CHECK (("deliveryLeaseToken" IS NULL) = ("deliveryLockedAt" IS NULL))`)
    await runner.query(`CREATE INDEX "IDX_notification_email_delivery" ON notification_inbox ("emailAvailableAt", "receivedAt") WHERE "emailState" IN ('pending', 'retry', 'deferred')`)
    await runner.query(`CREATE INDEX "IDX_notification_push_delivery" ON notification_inbox ("pushAvailableAt", "receivedAt") WHERE "pushState" IN ('pending', 'retry', 'deferred')`)
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX "IDX_notification_email_delivery"')
    await runner.query('DROP INDEX "IDX_notification_push_delivery"')
    await runner.query(`ALTER TABLE notification_inbox
      DROP CONSTRAINT "CHK_notification_delivery_lease",
      DROP COLUMN "emailState", DROP COLUMN "pushState",
      DROP COLUMN "emailAttempts", DROP COLUMN "pushAttempts",
      DROP COLUMN "emailAvailableAt", DROP COLUMN "pushAvailableAt",
      DROP COLUMN "emailReason", DROP COLUMN "pushReason",
      DROP COLUMN "deliveryLeaseToken", DROP COLUMN "deliveryLockedAt"`)
  }
}
