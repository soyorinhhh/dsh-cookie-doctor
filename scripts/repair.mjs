#!/usr/bin/env node
/**
 * 修复：把 Chromium cookie 库里堆积的 dsh-auth-* 行删掉（只删这些，不动别的 cookie）。
 *
 * 这一步是给「已经启动失败」的机器用的：那条 Web authentication failed 弹窗出现时，
 * host 进程还没起来，插件根本没机会运行，只能在外面把库清干净。
 * 已经在用插件的机器不需要它 —— 插件会自己保持只有 1 条。
 *
 * 用法：
 *   node scripts/repair.mjs --dry-run       # 先看看会删多少（不改任何数据）
 *   node scripts/repair.mjs --yes           # 真删（会先自动备份）；交互终端里可以省略 --yes
 *   node scripts/repair.mjs --keep-latest   # 保留最新创建的那条，其余删掉
 *   node scripts/repair.mjs --db <path>     # 指定 Cookies 文件
 *
 * 运行前必须完全退出 DeepSeek Harness（托盘里也要退）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
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

/** 交互确认：只在终端里问。非交互环境由调用方要求 --yes。 */
function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(question).finally(() => rl.close());
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

  // 找出「最新创建」的那条，--keep-latest 时保留它。
  // 用 creation_utc 而不是 expires_utc：过期时间是签发那一刻按寿命算出来的，
  // 顺序未必和创建顺序一致，拿它排会留错人。
  const keepNames = new Set();
  if (args.keepLatest) {
    const latest = [...targets]
      .sort((a, b) => Number(b.creation_utc ?? 0) - Number(a.creation_utc ?? 0))[0];
    if (latest) keepNames.add(String(latest.name));
  }
  const doomed = targets.filter((row) => !keepNames.has(String(row.name)));
  // 同一个名字可能在多个 host 下各有一行，按名字去重后逐条删。
  const doomedNames = [...new Set(doomed.map((row) => String(row.name)))];
  const keptCount = targets.length - doomed.length;

  log(
    args,
    `dsh-auth-* 共 ${targets.length} 条，将删除 ${doomed.length} 条` +
      (keptCount > 0 ? `，保留 ${keptCount} 条` : '')
  );
  if (args.dryRun) {
    log(args, '（--dry-run，没有改动任何数据）');
    if (args.json) {
      console.log(
        JSON.stringify(
          { ok: true, dryRun: true, total: targets.length, wouldRemove: doomed.length, wouldKeep: keptCount },
          null,
          2
        )
      );
    }
    return;
  }

  // 这是会写 Chromium cookie 库的破坏性操作：非交互环境必须显式 --yes，
  // 交互环境问一次。之前没有任何确认，一条命令就直接改库。
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      console.error('✗ 非交互环境必须显式加 --yes（会修改 Chromium 的 cookie 库）');
      console.error('  先看看会删什么：node scripts/repair.mjs --dry-run');
      process.exit(4);
    }
    const answer = await ask(`即将删除 ${doomed.length} 条 dsh-auth-* cookie，继续？[y/N] `);
    if (!/^y(es)?$/iu.test(answer.trim())) {
      log(args, '已取消，没有改动任何数据。');
      return;
    }
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
    // 按名字逐条删。不能用 `DELETE ... WHERE name LIKE 'dsh-auth-%'`：
    // 那是无条件全清，--keep-latest 要留的那条会被一起删掉（旧版实测 3 条全没了）。
    const statement = db.prepare('DELETE FROM cookies WHERE name = ?');
    db.exec('BEGIN');
    try {
      for (const name of doomedNames) {
        removed += Number(statement.run(name)?.changes ?? 0);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
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
    console.log(JSON.stringify({ ok: true, removed, remaining, kept: keptCount, backup: backupPath }, null, 2));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
