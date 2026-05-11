/**
 * Workspace Service - 文件工作区业务逻辑
 *
 * 提供目录树读取和 git 状态查询功能。
 */

import { exec } from 'child_process';
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
const ALLOWED_ROOTS = [
  '/mnt/d/workspace',
  '/home/dabai',
  '/home/dabai/.openclaw/workspace',
];

export function resolveSafePath(raw: string): string | null {
  if (!raw) return null;
  const normalized = raw.replace(/\\/g, '/');
  // 检查原始和解码后是否含 ..
  if (normalized.includes('..')) return null;
  if (decodeURIComponent(normalized).includes('..')) return null;
  const resolved = path.resolve(normalized);
  // 白名单校验
  if (!ALLOWED_ROOTS.some(root => resolved.startsWith(root + '/') || resolved === root)) {
    return null;
  }
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
 * 判断条目是目录还是文件（处理符号链接）
 * @returns 'directory' | 'file' | null（断链或无法识别）
 */
function resolveEntryType(entry: fs.Dirent, fullPath: string): 'directory' | 'file' | null {
  if (entry.isSymbolicLink()) {
    try {
      const stat = fs.statSync(fullPath); // follow symlink
      if (stat.isDirectory()) return 'directory';
      if (stat.isFile()) return 'file';
    } catch {
      // 断链（broken symlink），跳过
      return null;
    }
    return null;
  }
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return null;
}

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
    const fullPath = path.join(dirPath, entry.name);
    const entryType = resolveEntryType(entry, fullPath);

    if (entryType === null) continue; // broken symlink or unrecognized

    if (shouldIgnore(entry.name, entryType === 'directory', ignorePatterns)) continue;

    if (entryType === 'directory') {
      children.push(buildDirectoryTree(fullPath, maxDepth, depth + 1));
    } else {
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
 * 排除隐藏目录、node_modules、系统目录和 shouldIgnore 匹配项
 */
export function scanDirectories(dirPath: string): ScanResult {
  const SYSTEM_DIRS = new Set(['/proc', '/sys', '/dev', '/run', '/snap', '/boot']);

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  // 解析 .gitignore（复用 shouldIgnore）
  const gitignorePath = path.join(dirPath, '.gitignore');
  const ignorePatterns = parseGitignorePatterns(gitignorePath)
    .map(gitignorePatternToRegex)
    .filter((r): r is RegExp => r !== null);

  const directories = entries
    .filter(e => {
      // 排除非目录
      if (!e.isDirectory()) return false;
      // 排除隐藏目录
      if (e.name.startsWith('.')) return false;
      // 复用 shouldIgnore（含 node_modules 等常量忽略）
      if (shouldIgnore(e.name, true, ignorePatterns)) return false;
      // 排除系统目录
      const fullPath = path.join(dirPath, e.name);
      if (SYSTEM_DIRS.has(fullPath)) return false;
      return true;
    })
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
function getGitPorcelain(dirPath: string): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    const result = new Map<string, string>();
    const child = exec('git status --porcelain', {
      cwd: dirPath,
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) { resolve(result); return; }
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        // 格式: "XY filename" — X=index, Y=worktree
        const x = line[0]; // index 状态
        const y = line[1]; // worktree 状态
        const filePath = line.substring(3);
        // 重命名格式: "R  old -> new"
        const actualPath = filePath.includes(' -> ') ? filePath.split(' -> ').pop()!.trim() : filePath.trim();
        if (actualPath) {
          // index 优先：有 index 变化取 X，否则取 Y
          const meaningful = (x !== ' ' && x !== '?') ? x : y;
          result.set(actualPath, meaningful);
        }
      }
      resolve(result);
    });
    child.on('error', () => resolve(result));
  });
}

/**
 * 获取当前分支名
 */
function getGitBranch(dirPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = exec('git rev-parse --abbrev-ref HEAD', {
      cwd: dirPath,
      encoding: 'utf-8',
      timeout: 5000,
    }, (err, stdout) => {
      if (err) { resolve(null); return; }
      resolve(stdout.trim());
    });
    child.on('error', () => resolve(null));
  });
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
 * 向上查找 git 仓库根目录（含 .git 的最近祖先）
 */
function findGitRoot(dirPath: string): string | null {
  let current = dirPath;
  while (current) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * 获取目录树（含 git 状态）
 * @param maxDepth 最大递归深度，默认 1（懒加载模式）
 *
 * 始终从 git 仓库根执行 git status，结果过滤到请求路径下的文件，
 * 这样展开子目录时也能正确显示 git 状态。
 */
export async function getDirectoryTree(dirPath: string, maxDepth = 1): Promise<FileNode> {
  const tree = buildDirectoryTree(dirPath, maxDepth);

  // 向上查找 git 仓库根
  const gitRoot = findGitRoot(dirPath);
  if (gitRoot) {
    const gitMap = await getGitPorcelain(gitRoot);
    if (gitMap.size > 0) {
      // 只保留请求路径下的文件状态
      const relPrefix = path.relative(gitRoot, dirPath);
      let filteredMap = gitMap;
      if (relPrefix && relPrefix !== '.') {
        filteredMap = new Map<string, string>();
        const prefix = relPrefix + '/';
        for (const [filePath, status] of gitMap) {
          if (filePath.startsWith(prefix)) {
            filteredMap.set(filePath.substring(prefix.length), status);
          }
        }
      }
      if (filteredMap.size > 0) {
        mergeGitStatus(tree, filteredMap, dirPath);
      }
    }
  }

  return tree;
}

/**
 * 获取 git 状态统计摘要
 */
export async function getGitStatusSummary(dirPath: string): Promise<GitStatusSummary> {
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

  const branch = await getGitBranch(dirPath);
  if (!branch) return empty;

  const gitMap = await getGitPorcelain(dirPath);
  if (gitMap.size === 0) {
    return { isGitRepo: true, branch, modified: 0, added: 0, deleted: 0, untracked: 0 };
  }

  let modified = 0, added = 0, deleted = 0, untracked = 0;
  for (const status of gitMap.values()) {
    // 现在存的是单字符状态码
    if (status === '?') {
      untracked++;
    } else if (status === 'A' || status === 'C') {
      // C(copied) 算入 added（复制新增）
      added++;
    } else if (status === 'D') {
      deleted++;
    } else {
      // R(renamed) 及其他变更算入 modified
      modified++;
    }
  }

  return { isGitRepo: true, branch, modified, added, deleted, untracked };
}
