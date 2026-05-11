/**
 * Workspace Service - 文件工作区业务逻辑
 *
 * 提供目录树读取和 git 状态查询功能。
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
// ============================================================================
// 类型定义
// ============================================================================

export interface FileNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  children?: FileNode[];
  size?: number;
  gitStatus?: string | null;
}

export interface GitStatusSummary {
  isGitRepo: boolean;
  branch: string | null;
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
}

// ============================================================================
// 路径安全
// ============================================================================

/**
 * 校验路径安全性，防止目录穿越
 * @returns 解析后的绝对路径，若不安全返回 null
 */
export function resolveSafePath(raw: string): string | null {
  if (!raw) return null;
  const resolved = path.resolve(raw);
  // 不允许包含 .. 的原始路径
  if (raw.includes('..')) return null;
  return resolved;
}

/**
 * 检查路径是否存在且是目录
 */
export function validateDirectory(dirPath: string): 'ok' | 'not_found' | 'not_directory' {
  try {
    const stat = fs.statSync(dirPath);
    return stat.isDirectory() ? 'ok' : 'not_directory';
  } catch {
    return 'not_found';
  }
}

// ============================================================================
// .gitignore 解析
// ============================================================================

/**
 * 简单的 .gitignore 模式匹配
 * 只覆盖常见场景：通配符(*)、目录斜杠(/)、否定(!)
 */
function parseGitignorePatterns(gitignorePath: string): string[] {
  if (!fs.existsSync(gitignorePath)) return [];
  const content = fs.readFileSync(gitignorePath, 'utf-8');
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

/**
 * 将 .gitignore 模式转为正则
 */
function gitignorePatternToRegex(pattern: string): RegExp | null {
  // 否定模式暂不处理（复杂度高，且忽略的主要是正匹配）
  if (pattern.startsWith('!')) return null;

  let regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  // / 结尾表示只匹配目录
  const dirOnly = regex.endsWith('/');
  if (dirOnly) regex = regex.slice(0, -1);

  // 确保匹配完整名称
  try {
    return new RegExp(`(^|/)${regex}${dirOnly ? '(?:/|$)' : '(?:/|$)$'}`);
  } catch {
    return null;
  }
}

/**
 * 检查文件名是否应被忽略
 */
function shouldIgnore(name: string, isDir: boolean, patterns: RegExp[]): boolean {
  // 硬编码忽略列表
  const alwaysIgnore = ['node_modules', '.git', '.DS_Store', 'Thumbs.db'];
  if (alwaysIgnore.includes(name)) return true;

  return patterns.some(re => {
    const testPath = isDir ? `${name}/` : name;
    return re.test(testPath) || re.test(name);
  });
}

// ============================================================================
// 目录树
// ============================================================================

const MAX_DEPTH = 10;

/**
 * 构建目录树
 * @param maxDepth 最大递归深度，默认 1（只返回一级子项，懒加载模式）
 */
export function buildDirectoryTree(dirPath: string, maxDepth = 1, depth = 0): FileNode {
  const name = path.basename(dirPath);
  const node: FileNode = { name, type: 'directory', path: dirPath };

  if (depth >= maxDepth || depth >= MAX_DEPTH) {
    node.children = [];
    return node;
  }

  // 解析 .gitignore
  const gitignorePath = path.join(dirPath, '.gitignore');
  const ignorePatterns = parseGitignorePatterns(gitignorePath)
    .map(gitignorePatternToRegex)
    .filter((r): r is RegExp => r !== null);

  // 读取目录内容
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    node.children = [];
    return node;
  }

  // 排序：目录在前，文件在后，各自按名称排序
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const children: FileNode[] = [];
  for (const entry of entries) {
    if (shouldIgnore(entry.name, entry.isDirectory(), ignorePatterns)) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      children.push(buildDirectoryTree(fullPath, maxDepth, depth + 1));
    } else if (entry.isFile()) {
      let size: number | undefined;
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        // skip
      }
      children.push({ name: entry.name, type: 'file', path: fullPath, size, gitStatus: null });
    }
  }

  node.children = children;
  return node;
}

// ============================================================================
// 目录扫描（一级子目录）
// ============================================================================

export interface ScanDirectory {
  name: string;
  path: string;
}

export interface ScanResult {
  basePath: string;
  directories: ScanDirectory[];
}

/**
 * 扫描指定路径的一级子目录（非递归）
 */
export function scanDirectories(dirPath: string): ScanResult {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const directories = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => ({ name: e.name, path: path.join(dirPath, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { basePath: dirPath, directories };
}

// ============================================================================
// Git 状态
// ============================================================================

/**
 * 获取 git status --porcelain 的解析结果
 * @returns Map<相对路径, 状态码>
 */
function getGitPorcelain(dirPath: string): Map<string, string> {
  const result = new Map<string, string>();
  try {
    const output = execSync('git status --porcelain', {
      cwd: dirPath,
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024,
    });
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;
      // 格式: "XY filename" 或 "XY original -> renamed"
      const status = line.substring(0, 2).trim();
      const filePath = line.substring(3);
      // 重命名格式: "R  old -> new"
      const actualPath = filePath.includes(' -> ') ? filePath.split(' -> ').pop()!.trim() : filePath.trim();
      if (actualPath) {
        result.set(actualPath, status);
      }
    }
  } catch {
    // 非 git 仓库或 git 命令失败
  }
  return result;
}

/**
 * 获取当前分支名
 */
function getGitBranch(dirPath: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: dirPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 将 git status 合并到目录树中
 */
export function mergeGitStatus(tree: FileNode, gitMap: Map<string, string>, rootPath: string): void {
  if (!tree.children) return;
  for (const child of tree.children) {
    if (child.type === 'file') {
      const relativePath = path.relative(rootPath, child.path);
      child.gitStatus = gitMap.get(relativePath) ?? null;
    } else {
      mergeGitStatus(child, gitMap, rootPath);
    }
  }
}

/**
 * 获取目录树（含 git 状态）
 * @param maxDepth 最大递归深度，默认 1（懒加载模式）
 */
export function getDirectoryTree(dirPath: string, maxDepth = 1): FileNode {
  const tree = buildDirectoryTree(dirPath, maxDepth);

  // 检查是否为 git 仓库
  const gitDir = path.join(dirPath, '.git');
  if (fs.existsSync(gitDir)) {
    const gitMap = getGitPorcelain(dirPath);
    if (gitMap.size > 0) {
      mergeGitStatus(tree, gitMap, dirPath);
    }
  }

  return tree;
}

/**
 * 获取 git 状态统计摘要
 */
export function getGitStatusSummary(dirPath: string): GitStatusSummary {
  const empty: GitStatusSummary = {
    isGitRepo: false,
    branch: null,
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
  };

  const gitDir = path.join(dirPath, '.git');
  if (!fs.existsSync(gitDir)) return empty;

  const branch = getGitBranch(dirPath);
  if (!branch) return empty;

  const gitMap = getGitPorcelain(dirPath);
  if (gitMap.size === 0) {
    return { isGitRepo: true, branch, modified: 0, added: 0, deleted: 0, untracked: 0 };
  }

  let modified = 0, added = 0, deleted = 0, untracked = 0;
  for (const status of gitMap.values()) {
    if (status === '??' || status === 'A?' || status.startsWith('?')) {
      untracked++;
    } else if (status === 'A ' || status === 'AM' || status === 'A') {
      added++;
    } else if (status === 'D ' || status === 'D' || status.endsWith('D')) {
      deleted++;
    } else {
      modified++;
    }
  }

  return { isGitRepo: true, branch, modified, added, deleted, untracked };
}
