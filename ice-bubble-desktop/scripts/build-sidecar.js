/**
 * Build server sidecar for Tauri
 * 
 * Creates an isolated directory with only server dependencies,
 * then uses pkg to generate a standalone server.exe.
 * 
 * Must be run on the target platform (Windows for .exe output).
 * 
 * Usage: node scripts/build-sidecar.js
 */

import { execSync } from 'child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BUILD_DIR = join(ROOT, 'dist-server-sidecar');

// Server-only dependencies (runtime, not devDependencies)
const SERVER_DEPS = [
  'express',
  'ws',
  'cors',
  'http-proxy-middleware',
  'dompurify',
  'dotenv',
];

function clean() {
  if (existsSync(BUILD_DIR)) {
    rmSync(BUILD_DIR, { recursive: true, force: true });
  }
  mkdirSync(BUILD_DIR, { recursive: true });
}

function createMinimalPackage() {
  const pkg = {
    name: 'ice-bubble-server',
    version: '1.0.0',
    type: 'module',
    dependencies: {}
  };

  // Read versions from root package.json
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  for (const dep of SERVER_DEPS) {
    if (rootPkg.dependencies[dep]) {
      pkg.dependencies[dep] = rootPkg.dependencies[dep];
    }
  }

  writeFileSync(join(BUILD_DIR, 'package.json'), JSON.stringify(pkg, null, 2));
}

function installDeps() {
  console.log('Installing server-only dependencies...');
  execSync('npm install --production', { cwd: BUILD_DIR, stdio: 'inherit' });
}

function copyServerCode() {
  console.log('Copying built server code...');
  cpSync(join(ROOT, 'dist-server', 'index.js'), join(BUILD_DIR, 'index.js'));
  
  // Copy config directory if exists
  const configDir = join(ROOT, 'config');
  if (existsSync(configDir)) {
    cpSync(configDir, join(BUILD_DIR, 'config'), { recursive: true });
  }
}

function createPkgConfig() {
  const pkgConfig = {
    pkg: {
      assets: ['config/*'],
      targets: ['node18-win-x64'],
      outputPath: '.',
    },
    scripts: {
      'build:exe': 'npx pkg index.js --config package.json --compress GZip -o server'
    }
  };

  // Merge into the minimal package.json
  const pkgPath = join(BUILD_DIR, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  Object.assign(pkg, pkgConfig);
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}

function buildExe() {
  console.log('Building server.exe with pkg...');
  execSync('npx pkg index.js --config package.json --compress GZip -o server', {
    cwd: BUILD_DIR,
    stdio: 'inherit'
  });
}

function copyToTauri() {
  // Tauri expects sidecars named: {name}-{target-triple}.exe
  const srcExe = join(BUILD_DIR, 'server.exe');
  if (!existsSync(srcExe)) {
    console.error('ERROR: server.exe was not generated');
    process.exit(1);
  }

  const binDir = join(ROOT, 'src-tauri', 'binaries');
  mkdirSync(binDir, { recursive: true });
  
  const dstExe = join(binDir, 'server-x86_64-pc-windows-msvc.exe');
  cpSync(srcExe, dstExe);
  console.log(`\n✅ Sidecar copied to: ${dstExe}`);
}

// Main
clean();
createMinimalPackage();
installDeps();
copyServerCode();
createPkgConfig();
buildExe();
copyToTauri();
console.log('\n✅ Server sidecar build complete!');
console.log('Run `npm run tauri build` to create the installer.');
