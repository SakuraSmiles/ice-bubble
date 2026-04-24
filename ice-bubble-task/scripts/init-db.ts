/**
 * 数据库初始化脚本
 */

import { resolve } from 'path';
import { DBManager } from '../src/storage/db-manager.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const dbPath = resolve(__dirname, '..', 'data', 'task.db');
  const dbManager = new DBManager();

  await dbManager.init({ dbPath });
  await dbManager.migrate(1);

  logger.info('Database initialized', { dbPath });
  await dbManager.close();
}

main().catch((err) => {
  logger.error('Init failed', { error: err });
  process.exit(1);
});
