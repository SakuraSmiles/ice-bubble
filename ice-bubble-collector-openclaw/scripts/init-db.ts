#!/usr/bin/env node
/**
 * 数据库初始化脚本
 * 
 * 用途：初始化 SQLite 数据库，创建表结构
 * 使用：npx tsx scripts/init-db.ts
 */

import { SQLiteManager } from '../src/storage/SQLiteManager.js';
import * as path from 'path';

async function initDatabase() {
  console.log('=== 数据库初始化脚本 ===\n');

  // 数据库路径
  const dbPath = process.argv[2] || './data/collector.db';
  
  console.log(`数据库路径: ${dbPath}\n`);

  try {
    // 创建 SQLiteManager 实例
    const db = new SQLiteManager({
      dbPath: path.resolve(dbPath),
      walMode: true,
    });

    console.log('✅ 数据库初始化成功');
    console.log('✅ 表结构创建完成');
    console.log('\n已创建的表:');
    console.log('  - sessions');
    console.log('  - messages');
    console.log('  - agents');
    console.log('  - tools');

    // 关闭数据库连接
    db.close();

    console.log('\n✅ 数据库初始化完成！');

  } catch (error) {
    console.error('❌ 数据库初始化失败:', error);
    process.exit(1);
  }
}

initDatabase();
