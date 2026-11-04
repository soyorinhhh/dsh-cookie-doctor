#!/usr/bin/env node
/**
 * 修复：把 Chromium cookie 库里堆积的 dsh-auth-* 行删掉（只删这些，不动别的 cookie）。
 *
 * 这一步是给「已经启动失败」的机器用的：那条 Web authentication failed 弹窗出现时，
 * host 进程还没起来，插件根本没机会运行，只能在外面把库清干净。
 * 已经在用插件的机器不需要它 —— 插件会自己保持只有 1 条。
 *
 * 用法：
 *   node scripts/repair.mjs --dry-run      # 先看看会删多少
 *   node scripts/repair.mjs                # 真删（会先自动备份）
 *   node scripts/repair.mjs --keep-latest  # 保留最新那条，其余删掉
 *   node scripts/repair.mjs --db <path>    # 指定 Cookies 文件
 *
 * 运行前必须完全退出 DeepSeek Harness（托盘里也要退）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCookieDbPath, readCookies } from './diagnose.mjs';

const COOKIE_PREFIX = 'dsh-auth-';

function parseArgs(argv) {
  const args = { db: undefined, dryRun: false, yes: false, keepLatest: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--db') args.db = argv[++i];
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--yes' || token === '-y') args.yes = true;
    else if (token === '--keep-latest') args.keepLatest = true;
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

function log(args, message) {
  if (!args.json) console.log(message);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/repair.mjs [--db <path>] [--dry-run] [--keep-latest] [--yes] [--json]');
    return;
  }
  const dbPath = args.db ?? defaultCookieDbPath();
  log(args, `cookie 库：${dbPath}`);

  const probe = await readCookies(dbPath);
  if (!probe.ok) {
    console.error(`✗ ${probe.reason}`);
    process.exit(2);
  }
  const targets = probe.rows.filter((row) => String(row.name).startsWith(COOKIE_PREFIX));
  if (targets.length === 0) {
    log(args, '✅ 库里没有 dsh-auth-* cookie，不需要清理。');
    if (args.json) console.log(JSON.stringify({ ok: true, removed: 0, kept: 0 }, null, 2));
    return;
  }

  // 找出最新的一条（creation_utc 最大），--keep-latest 时保留它
  let keepNames = new Set();
  if (args.keepLatest) {
    const latest = [...targets].sort((a, b) => Number(b.expires_utc ?? 0) - Number(a.expires_utc ?? 0))[0];
    if (latest) keepNames.add(String(latest.name));
  }
  const doomed = targets.filter((row) => !keepNames.has(String(row.name)));

  log(args, `dsh-auth-* 共 ${targets.length} 条，将删除 ${doomed.length} 条${keepNames.size ? '，保留 1 条' : ''}`);
  if (args.dryRun) {
    log(args, '（--dry-run，没有改动任何数据）');
    if (args.json) {
      console.log(JSON.stringify({ ok: true, dryRun: true, total: targets.length, wouldRemove: doomed.length }, null, 2));
    }
    return;
  }

  // 写之前先备份，出问题可以直接还原
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.bak-${stamp}`;
  fs.copyFileSync(dbPath, backupPath);
  log(args, `已备份 → ${path.basename(backupPath)}`);

  const { DatabaseSync } = await import('node:sqlite');
  let db;
  let removed = 0;
  try {
    db = new DatabaseSync(dbPath);
    const statement = db.prepare('DELETE FROM cookies WHERE name LIKE ?');
    const result = statement.run(`${COOKIE_PREFIX}%`);
    removed = Number(result?.changes ?? 0);
    db.exec('PRAGMA optimize');
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    console.error(`✗ 写入失败：${message}`);
    console.error('  多半是 DSH 还在运行。请连托盘一起完全退出后再试；备份在 ' + backupPath);
    process.exit(3);
  } finally {
    try {
      db?.close();
    } catch {}
  }

  const after = await readCookies(dbPath);
  const remaining = after.ok ? after.rows.filter((row) => String(row.name).startsWith(COOKIE_PREFIX)).length : -1;
  log(args, `✅ 删掉 ${removed} 条，库里现在还剩 ${remaining} 条 dsh-auth-* cookie`);
  log(args, '现在可以重新启动 DeepSeek Harness 了。建议顺手装上插件，避免再次堆积。');
  if (args.json) {
    console.log(JSON.stringify({ ok: true, removed, remaining, backup: backupPath }, null, 2));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
