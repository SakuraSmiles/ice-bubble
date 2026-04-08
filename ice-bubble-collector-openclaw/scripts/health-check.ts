#!/usr/bin/env node
/**
 * 健康检查脚本
 * 
 * 用途：检查系统健康状态
 * 使用：npx tsx scripts/health-check.ts
 */

import * as fs from 'fs';
import * as path from 'path';

async function healthCheck() {
  console.log('=== 健康检查脚本 ===\n');

  const checks: Array<{ name: string; status: boolean; message: string }> = [];

  // 1. 检查配置文件
  const configPath = './config/config.json';
  const configExists = fs.existsSync(configPath);
  checks.push({
    name: '配置文件',
    status: configExists,
    message: configExists ? '配置文件存在' : '配置文件不存在',
  });

  // 2. 检查数据库文件
  const dbPath = './data/collector.db';
  const dbExists = fs.existsSync(dbPath);
  checks.push({
    name: '数据库文件',
    status: dbExists,
    message: dbExists ? '数据库文件存在' : '数据库文件不存在',
  });

  // 3. 检查日志目录
  const logsDir = './logs';
  const logsExists = fs.existsSync(logsDir);
  checks.push({
    name: '日志目录',
    status: logsExists,
    message: logsExists ? '日志目录存在' : '日志目录不存在',
  });

  // 4. 检查备份目录
  const backupsDir = './backups';
  const backupsExists = fs.existsSync(backupsDir);
  checks.push({
    name: '备份目录',
    status: backupsExists,
    message: backupsExists ? '备份目录存在' : '备份目录不存在',
  });

  // 输出检查结果
  checks.forEach((check) => {
    const icon = check.status ? '✅' : '❌';
    console.log(`${icon} ${check.name}: ${check.message}`);
  });

  // 统计
  const passedCount = checks.filter((c) => c.status).length;
  const totalCount = checks.length;

  console.log(`\n检查结果: ${passedCount}/${totalCount} 通过`);

  // 返回退出码
  process.exit(passedCount === totalCount ? 0 : 1);
}

healthCheck();
