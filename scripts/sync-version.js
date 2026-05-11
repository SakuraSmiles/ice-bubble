#!/usr/bin/env node

/**
 * sync-version.js — 从根 package.json 同步版本号到所有子模块
 *
 * 更新位置：
 * - 所有 workspace package.json 的 version 字段
 * - README.md 中的版本号
 * - ice-bubble-desktop/src-tauri/tauri.conf.json 的 version 字段
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const VERSION = rootPkg.version;

const TARGETS = [
  { file: 'ice-bubble-admin/package.json', type: 'json' },
  { file: 'ice-bubble-collector-openclaw/package.json', type: 'json' },
  { file: 'ice-bubble-desktop/package.json', type: 'json' },
  { file: 'ice-bubble-desktop/src-tauri/tauri.conf.json', type: 'json' },
];

const README_PATH = 'README.md';

let updated = 0;

// 1. 更新 JSON 文件的 version 字段
for (const target of TARGETS) {
  const filePath = path.join(ROOT, target.file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (data.version !== VERSION) {
    data.version = VERSION;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    console.log(`  ✅ ${target.file} → ${VERSION}`);
    updated++;
  } else {
    console.log(`  ⏭️  ${target.file} (已是 ${VERSION})`);
  }
}

// 2. 更新 README.md 中的版本号
const readmePath = path.join(ROOT, README_PATH);
const readmeContent = fs.readFileSync(readmePath, 'utf-8');
const versionRegex = /(\*\*当前版本：\*\* `)([^`]+)(`)/;
const match = readmeContent.match(versionRegex);
if (match && match[2] !== VERSION) {
  const newReadme = readmeContent.replace(versionRegex, `$1${VERSION}$3`);
  fs.writeFileSync(readmePath, newReadme, 'utf-8');
  console.log(`  ✅ ${README_PATH} → ${VERSION}`);
  updated++;
} else if (match) {
  console.log(`  ⏭️  ${README_PATH} (已是 ${VERSION})`);
} else {
  console.log(`  ⚠️  ${README_PATH} 未找到版本号标记`);
}

console.log(`\n🎉 版本同步完成: ${VERSION} (${updated} 个文件已更新)`);
