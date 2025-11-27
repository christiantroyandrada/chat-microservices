import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm'

export class InitialSchema1733150000000 implements MigrationInterface {
  name = 'InitialSchema1733150000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ensure uuid-ossp extension exists for UUID generation
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')

    // Check if messages table already exists (skip if already migrated)
    const messagesTableExists = await queryRunner.hasTable('messages')
    if (!messagesTableExists) {
      // Create the enum type first
      await queryRunner.query(`
        DO $$ BEGIN
          CREATE TYPE "message_status_enum" AS ENUM ('NotDelivered', 'Delivered', 'Seen');
        EXCEPTION
          WHEN duplicate_object THEN null;
        END $$;
      `)

      await queryRunner.createTable(
        new Table({
          name: 'messages',
          columns: [
            {
              name: 'id',
              type: 'uuid',
              isPrimary: true,
              generationStrategy: 'uuid',
              default: 'uuid_generate_v4()',
            },
            {
              name: 'senderId',
              type: 'varchar',
              length: '255',
            },
            {
              name: 'receiverId',
              type: 'varchar',
              length: '255',
            },
            {
              name: 'message',
              type: 'text',
            },
            {
              name: 'isEncrypted',
              type: 'boolean',
              default: false,
            },
            {
              name: 'status',
              type: 'message_status_enum',
              default: "'NotDelivered'",
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
        'messages',
        new TableIndex({
          name: 'IDX_messages_senderId_receiverId',
          columnNames: ['senderId', 'receiverId'],
        })
      )
      await queryRunner.createIndex(
        'messages',
        new TableIndex({
          name: 'IDX_messages_senderId',
          columnNames: ['senderId'],
        })
      )
      await queryRunner.createIndex(
        'messages',
        new TableIndex({
          name: 'IDX_messages_receiverId',
          columnNames: ['receiverId'],
        })
      )

      console.log('✅ Created messages table with indexes')
    } else {
      console.log('⏭️ Messages table already exists, skipping...')
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('messages', true)
    await queryRunner.query('DROP TYPE IF EXISTS "message_status_enum"')
  }
}
