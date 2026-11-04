#!/usr/bin/env node
/**
 * 体检：数一数 Chromium 的 cookie 库里到底堆了多少条 dsh-auth-* cookie，
 * 以及这些 cookie 拼出来的请求头会不会撞上 Node 的 16KB 上限。
 *
 * 用法：
 *   node scripts/diagnose.mjs                # 用默认的桌面版路径
 *   node scripts/diagnose.mjs --db <path>    # 指定 Cookies 文件（可以先复制一份再看）
 *   node scripts/diagnose.mjs --json         # 只输出 JSON，方便脚本消费
 *
 * 注意：DSH 运行中这个文件是被 Chromium 独占锁着的，请先完全退出 DSH。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_DEFAULT_MAX_HEADER_BYTES = 16 * 1024;
const COOKIE_PREFIX = 'dsh-auth-';

export function defaultCookieDbPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies');
  }
  return path.join(home, '.config', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies');
}

function parseArgs(argv) {
  const args = { db: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--db') args.db = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

/**
 * 读取 cookie 库。用 node 内置的 node:sqlite，不引入任何依赖。
 * @returns {Promise<{ok: true, rows: Array, path: string} | {ok: false, reason: string, path: string}>}
 */
export async function readCookies(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: `找不到 cookie 库：${dbPath}`, path: dbPath };
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return { ok: false, reason: '当前 Node 没有 node:sqlite（需要 Node ≥ 22.5）', path: dbPath };
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      'SELECT host_key, name, path, length(value) AS valueLength, length(encrypted_value) AS encryptedLength, expires_utc FROM cookies'
    ).all();
    return { ok: true, rows, path: dbPath };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    let reason = message;
    if (/busy|locked|EBUSY|EPERM|unable to open/i.test(message)) {
      reason = `cookie 库被占用（${message}）。请先完全退出 DeepSeek Harness 再试。`;
    }
    return { ok: false, reason, path: dbPath };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export function analyze(rows) {
  const dsh = rows.filter((row) => String(row.name).startsWith(COOKIE_PREFIX));
  const byHost = new Map();
  for (const row of dsh) {
    const host = row.host_key ?? '';
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(row);
  }
  // Cookie 头 = 每条 `name=value; `，value 为空时 Chromium 用加密列，长度按 200 估算
  const headerBytesFor = (list) =>
    list.reduce((sum, row) => sum + String(row.name).length + 1 + (row.valueLength || row.encryptedLength || 200) + 2, 0);

  const worstHost = [...byHost.entries()]
    .map(([host, list]) => ({ host, count: list.length, headerBytes: headerBytesFor(list) }))
    .sort((a, b) => b.headerBytes - a.headerBytes)[0] ?? { host: '-', count: 0, headerBytes: 0 };

  const otherCookies = rows.length - dsh.length;
  return {
    total: rows.length,
    dshTotal: dsh.length,
    otherCookies,
    worstHost,
    verdict:
      worstHost.headerBytes > NODE_DEFAULT_MAX_HEADER_BYTES
        ? 'broken'
        : worstHost.headerBytes > NODE_DEFAULT_MAX_HEADER_BYTES * 0.75
          ? 'danger'
          : worstHost.headerBytes > 4096
            ? 'warning'
            : 'healthy',
    hosts: [...byHost.entries()].map(([host, list]) => ({
      host,
      count: list.length,
      headerBytes: headerBytesFor(list),
      names: list.map((row) => String(row.name)).sort()
    }))
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/diagnose.mjs [--db <path>] [--json]');
    return;
  }
  const dbPath = args.db ?? defaultCookieDbPath();
  const read = await readCookies(dbPath);
  if (!read.ok) {
    if (args.json) console.log(JSON.stringify({ ok: false, error: read.reason, path: read.path }, null, 2));
    else console.error(`✗ ${read.reason}`);
    process.exit(2);
  }
  const report = analyze(read.rows);

  if (args.json) {
    console.log(JSON.stringify({ ok: true, path: read.path, ...report }, null, 2));
    return;
  }

  console.log(`cookie 库：${read.path}`);
  console.log(`cookie 总数：${report.total}（其中 dsh-auth-* ${report.dshTotal} 条，其它 ${report.otherCookies} 条）`);
  for (const host of report.hosts) {
    console.log(`\n  ${host.host}  → ${host.count} 条，拼成请求头约 ${host.headerBytes} 字节`);
    const shown = host.names.slice(0, 6);
    for (const name of shown) console.log(`     ${name}`);
    if (host.names.length > shown.length) console.log(`     … 还有 ${host.names.length - shown.length} 条`);
  }

  const labels = {
    healthy: '✅ 正常：远低于上限，不用处理',
    warning: '🟡 偏多：再重启几轮可能出问题，建议装插件让它自动清理',
    danger: '🟠 危险：已经接近 Node 的 16KB 请求头上限',
    broken: '🔴 已经炸了：请求头超过 16KB，启动必定报 Web authentication failed'
  };
  console.log(`\n${labels[report.verdict]}`);
  console.log(`   Node 默认请求头上限 ${NODE_DEFAULT_MAX_HEADER_BYTES} 字节，当前最坏 ${report.worstHost.headerBytes} 字节`);
  if (report.verdict === 'danger' || report.verdict === 'broken') {
    console.log('\n建议立即运行：node scripts/repair.mjs --dry-run  看会清掉什么，再去掉 --dry-run 真清');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
