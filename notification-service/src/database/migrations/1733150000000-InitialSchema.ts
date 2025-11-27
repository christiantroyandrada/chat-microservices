import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm'

export class InitialSchema1733150000000 implements MigrationInterface {
  name = 'InitialSchema1733150000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ensure uuid-ossp extension exists for UUID generation
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')

    // Check if notifications table already exists (skip if already migrated)
    const notificationsTableExists = await queryRunner.hasTable('notifications')
    if (!notificationsTableExists) {
      // Create the enum type first
      await queryRunner.query(`
        DO $$ BEGIN
          CREATE TYPE "notification_type_enum" AS ENUM ('message', 'system', 'alert');
        EXCEPTION
          WHEN duplicate_object THEN null;
        END $$;
      `)

      await queryRunner.createTable(
        new Table({
          name: 'notifications',
          columns: [
            {
              name: 'id',
              type: 'uuid',
              isPrimary: true,
              generationStrategy: 'uuid',
              default: 'uuid_generate_v4()',
            },
            {
              name: 'userId',
              type: 'varchar',
              length: '255',
            },
            {
              name: 'type',
              type: 'notification_type_enum',
            },
            {
              name: 'title',
              type: 'varchar',
              length: '255',
            },
            {
              name: 'message',
              type: 'text',
            },
            {
              name: 'read',
              type: 'boolean',
              default: false,
            },
            {
              name: 'createdAt',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
            },
            {
              name: 'updatedAt',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
            },
          ],
        }),
        true
      )

      // Create indexes for performance
      await queryRunner.createIndex(
        'notifications',
        new TableIndex({
          name: 'IDX_notifications_userId',
          columnNames: ['userId'],
        })
      )
      await queryRunner.createIndex(
        'notifications',
        new TableIndex({
          name: 'IDX_notifications_userId_createdAt',
          columnNames: ['userId', 'createdAt'],
        })
      )
      await queryRunner.createIndex(
        'notifications',
        new TableIndex({
          name: 'IDX_notifications_userId_read',
          columnNames: ['userId', 'read'],
        })
      )
      await queryRunner.createIndex(
        'notifications',
        new TableIndex({
          name: 'IDX_notifications_read',
          columnNames: ['read'],
        })
      )

      console.log('✅ Created notifications table with indexes')
    } else {
      console.log('⏭️ Notifications table already exists, skipping...')
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('notifications', true)
    await queryRunner.query('DROP TYPE IF EXISTS "notification_type_enum"')
  }
}
