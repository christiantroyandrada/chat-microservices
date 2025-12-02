import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm'

export class InitialSchema1733150000000 implements MigrationInterface {
  name = 'InitialSchema1733150000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check if users table already exists (skip if already migrated)
    const usersTableExists = await queryRunner.hasTable('users')
    if (!usersTableExists) {
      await queryRunner.createTable(
        new Table({
          name: 'users',
          columns: [
            {
              name: 'id',
              type: 'uuid',
              isPrimary: true,
              generationStrategy: 'uuid',
              default: 'uuid_generate_v4()',
            },
            {
              name: 'username',
              type: 'varchar',
              length: '64',
              isUnique: true,
            },
            {
              name: 'email',
              type: 'varchar',
              length: '255',
              isUnique: true,
            },
            {
              name: 'password',
              type: 'varchar',
              length: '255',
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
      console.log('✅ Created users table')
    } else {
      console.log('⏭️ Users table already exists, skipping...')
    }

    // Check if prekeys table already exists
    const prekeysTableExists = await queryRunner.hasTable('prekeys')
    if (!prekeysTableExists) {
      await queryRunner.createTable(
        new Table({
          name: 'prekeys',
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
              name: 'deviceId',
              type: 'varchar',
              length: '255',
            },
            {
              name: 'bundle',
              type: 'json',
            },
            {
              name: 'lastBackupTimestamp',
              type: 'timestamp',
              isNullable: true,
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
      console.log('✅ Created prekeys table')
    } else {
      console.log('⏭️ Prekeys table already exists, skipping...')
    }

    // Ensure uuid-ossp extension exists for UUID generation
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('prekeys', true)
    await queryRunner.dropTable('users', true)
  }
}
