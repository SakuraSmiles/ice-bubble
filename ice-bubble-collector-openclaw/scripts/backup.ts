#!/usr/bin/env node
/**
 * 数据备份脚本
 * 
 * 用途：备份 SQLite 数据库文件
 * 使用：npx tsx scripts/backup.ts [backup-path]
 */

import * as fs from 'fs';
import * as path from 'path';

async function backupDatabase() {
  console.log('=== 数据备份脚本 ===\n');

  // 配置
  const dbPath = process.argv[2] || './data/collector.db';
  const backupDir = process.argv[3] || './backups';
  
  // 创建备份目录
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // 生成备份文件名
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `collector-${timestamp}.db`;
  const backupPath = path.join(backupDir, backupFileName);

  try {
    // 检查源数据库是否存在
    if (!fs.existsSync(dbPath)) {
      throw new Error(`数据库文件不存在: ${dbPath}`);
    }

    // 复制数据库文件
    fs.copyFileSync(dbPath, backupPath);

    const stats = fs.statSync(backupPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    console.log(`✅ 备份成功`);
    console.log(`   源文件: ${dbPath}`);
    console.log(`   备份文件: ${backupPath}`);
    console.log(`   文件大小: ${sizeMB} MB`);

  } catch (error) {
    console.error('❌ 备份失败:', error);
    process.exit(1);
  }
}

backupDatabase();
