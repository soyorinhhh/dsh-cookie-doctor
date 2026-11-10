#!/usr/bin/env node
/**
 * 把插件装进某个 DSH profile。
 *
 * DSH 的插件是 cordis bundle：profile 的 package.json 里
 *   - dsh.profile.bundles 列出的 bundle 会被加载
 *   - 包本身必须能从 profile 的 node_modules 解析到
 * 所以安装 = 建一个 junctions + 改两处 package.json 字段，不需要联网、不需要 pnpm。
 *
 * 用法：
 *   node scripts/install.mjs                 # 装进 ~/.dsh/profiles/desktop
 *   node scripts/install.mjs --dry-run       # 只说要做什么
 *   node scripts/install.mjs --uninstall     # 卸载
 *   node scripts/install.mjs --profile <dir> # 指定 profile 目录
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'dsh-cookie-doctor';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function parseArgs(argv) {
  const args = { dryRun: false, uninstall: false, home: undefined, profile: undefined };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--uninstall') args.uninstall = true;
    else if (token === '--home') args.home = argv[++i];
    else if (token === '--profile') args.profile = argv[++i];
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

const toPosix = (value) => value.replaceAll('\\', '/');

function linkDirectory(target, linkPath, dryRun) {
  if (fs.existsSync(linkPath) || isSymlink(linkPath)) {
    console.log(`   已存在，跳过：${linkPath}`);
    return;
  }
  console.log(`   链接 ${linkPath} -> ${target}`);
  if (dryRun) return;
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    // Windows 上目录 junction 不需要管理员权限
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    // junction 失败就退回复制（最坏情况，但能用）
    console.log(`   ⚠ 建链接失败（${error.message}），改为复制文件`);
    fs.cpSync(target, linkPath, { recursive: true });
  }
}

/** 路径是不是链接（含 Windows junction）。只看类型，不看存在性。 */
function isSymlink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 真实目录里是不是本插件（copy 兜底时才会是真实目录）。 */
function looksLikeOurPackage(dirPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8'));
    return pkg.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * 删除一个安装入口。
 * 链接直接 unlink；真实目录（复制兜底产生的）要先确认它是我们的包，
 * 否则宁可跳过 —— 旧版把「存在」当成「是链接」，对真实目录 rmSync 会直接抛错，
 * 更糟的情况是删掉一个不是本插件的目录。
 */
function removeLink(entryPath, dryRun) {
  let stat;
  try {
    stat = fs.lstatSync(entryPath);
  } catch {
    console.log(`   不存在：${entryPath}`);
    return false;
  }
  const link = stat.isSymbolicLink();
  if (!link && stat.isDirectory() && !looksLikeOurPackage(entryPath)) {
    console.log(`   ⚠ 不是链接、也不像本插件的目录，跳过：${entryPath}`);
    return false;
  }
  console.log(`   ${link ? '删除链接' : '删除目录'} ${entryPath}`);
  if (dryRun) return true;
  if (link) fs.unlinkSync(entryPath);
  else fs.rmSync(entryPath, { recursive: true, force: true });
  return true;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonWithBackup(filePath, data, dryRun) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${filePath}.bak-${stamp}`;
  // 先判断 dry-run 再打印：否则会输出「备份了」但其实什么都没做，误导使用者。
  if (dryRun) {
    console.log(`   将备份 ${path.basename(filePath)} 并写入新内容`);
    return;
  }
  console.log(`   备份 ${path.basename(filePath)} → ${path.basename(backup)}`);
  fs.copyFileSync(filePath, backup);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/install.mjs [--dry-run] [--uninstall] [--home <DSH_HOME>] [--profile <name|dir>]');
    return;
  }

  const home = args.home ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const profileArg = args.profile ?? 'desktop';
  const profileDir = path.isAbsolute(profileArg)
    ? profileArg
    : path.join(home, 'profiles', profileArg);
  const profilePkgPath = path.join(profileDir, 'package.json');
  const pluginDir = path.join(home, 'plugins', PACKAGE_NAME);
  const nodeModulesLink = path.join(profileDir, 'node_modules', PACKAGE_NAME);

  console.log(`仓库：      ${repoRoot}`);
  console.log(`DSH home：  ${home}`);
  console.log(`profile：   ${profileDir}`);
  console.log(`模式：      ${args.uninstall ? '卸载' : '安装'}${args.dryRun ? '（dry-run）' : ''}\n`);

  if (!fs.existsSync(profilePkgPath)) {
    console.error(`✗ 找不到 ${profilePkgPath}`);
    console.error('  请确认 DSH 桌面版至少启动过一次，或用 --profile 指定正确的 profile。');
    process.exit(2);
  }
  if (!args.uninstall && !fs.existsSync(path.join(repoRoot, 'lib', 'index.js'))) {
    console.error('✗ 仓库里没有 lib/index.js，请确认脚本是从仓库根目录运行的');
    process.exit(2);
  }

  const profilePkg = readJson(profilePkgPath);
  profilePkg.dsh ??= {};
  profilePkg.dsh.profile ??= {};
  const bundles = Array.isArray(profilePkg.dsh.profile.bundles) ? profilePkg.dsh.profile.bundles : [];
  profilePkg.dependencies ??= {};

  if (args.uninstall) {
    removeLink(nodeModulesLink, args.dryRun);
    removeLink(pluginDir, args.dryRun);
    const nextBundles = bundles.filter((name) => name !== PACKAGE_NAME);
    const changed = nextBundles.length !== bundles.length || profilePkg.dependencies[PACKAGE_NAME] !== undefined;
    if (!changed) {
      console.log('\n没有发现已安装的痕迹，什么都没做。');
      return;
    }
    profilePkg.dsh.profile.bundles = nextBundles;
    delete profilePkg.dependencies[PACKAGE_NAME];
    writeJsonWithBackup(profilePkgPath, profilePkg, args.dryRun);
    console.log('\n✅ 已卸载，重启 DSH 后生效。');
    return;
  }

  console.log('1. 插件目录');
  linkDirectory(repoRoot, pluginDir, args.dryRun);

  console.log('2. profile/node_modules 入口');
  linkDirectory(pluginDir, nodeModulesLink, args.dryRun);

  console.log('3. profile/package.json');
  profilePkg.dependencies[PACKAGE_NAME] = `link:${toPosix(pluginDir)}`;
  console.log(`   dependencies["${PACKAGE_NAME}"] = link:${toPosix(pluginDir)}`);
  if (!bundles.includes(PACKAGE_NAME)) {
    bundles.push(PACKAGE_NAME);
    console.log(`   dsh.profile.bundles += ${PACKAGE_NAME}`);
  } else {
    console.log('   dsh.profile.bundles 里已经有了');
  }
  profilePkg.dsh.profile.bundles = bundles;
  writeJsonWithBackup(profilePkgPath, profilePkg, args.dryRun);

  console.log('\n✅ 安装完成。');
  console.log('   重启 DeepSeek Harness 后插件生效；想确认是否真的生效，重启后看：');
  console.log(`   ${path.join(home, 'cookie-doctor', 'report.json')}`);
  if (args.dryRun) console.log('\n（dry-run，没有真正改动任何文件）');
}

main();
