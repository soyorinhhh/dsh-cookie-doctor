/**
 * 验证 diagnose.mjs / repair.mjs：用一张 Chromium 同结构的 cookie 库造数据。
 */
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function createFixture(dbPath, dshCount, otherCount) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE cookies(
      creation_utc INTEGER NOT NULL,
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      encrypted_value BLOB DEFAULT '',
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL,
      last_access_utc INTEGER NOT NULL,
      has_expires INTEGER NOT NULL DEFAULT 1,
      is_persistent INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 1,
      samesite INTEGER NOT NULL DEFAULT -1,
      source_scheme INTEGER NOT NULL DEFAULT 0,
      source_port INTEGER NOT NULL DEFAULT -1,
      last_update_utc INTEGER NOT NULL DEFAULT 0,
      source_type INTEGER NOT NULL DEFAULT 0,
      has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(host_key, top_frame_site_key, name, path, source_scheme, source_port)
    );
  `);
  const insert = db.prepare(
    'INSERT INTO cookies(creation_utc, host_key, name, value, path, expires_utc, is_secure, is_httponly, last_access_utc) VALUES(?,?,?,?,?,?,?,?,?)'
  );
  const value = 'x'.repeat(200);
  for (let i = 0; i < dshCount; i++) {
    insert.run(1000 + i, '127.0.0.1', `dsh-auth-${String(i).padStart(43, 'a')}`, value, '/', 9e15, 0, 1, 2000 + i);
  }
  for (let i = 0; i < otherCount; i++) {
    insert.run(3000 + i, 'example.com', `normal-cookie-${i}`, `v${i}`, '/', 9e15, 1, 0, 4000 + i);
  }
  db.close();
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'cookie-doctor-db-'));
const dbPath = path.join(dir, 'Cookies');
let failures = 0;
const check = (label, pass, extra = '') => {
  console.log(`  ${pass ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!pass) failures++;
};

try {
  createFixture(dbPath, 80, 3);
  console.log('造了一张 80 条 dsh-auth-* + 3 条普通 cookie 的库\n');

  console.log('== diagnose ==');
  const diag = run(['scripts/diagnose.mjs', '--db', dbPath, '--json']);
  let diagJson = null;
  try {
    diagJson = JSON.parse(diag.stdout);
  } catch {}
  check('diagnose 正常退出', diag.code === 0, `exit=${diag.code} ${diag.stderr.slice(0, 120)}`);
  check('识别出 80 条 dsh-auth-*', diagJson?.dshTotal === 80, `实际 ${diagJson?.dshTotal}`);
  check('判定为 broken（请求头超 16KB）', diagJson?.verdict === 'broken', `verdict=${diagJson?.verdict}`);
  check('请求头估算超过 16384', (diagJson?.worstHost?.headerBytes ?? 0) > 16384, `${diagJson?.worstHost?.headerBytes} 字节`);

  console.log('\n== repair --dry-run ==');
  const dry = run(['scripts/repair.mjs', '--db', dbPath, '--dry-run', '--json']);
  let dryJson = null;
  try {
    dryJson = JSON.parse(dry.stdout);
  } catch {}
  check('dry-run 不删数据', (() => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const n = db.prepare('SELECT count(*) AS c FROM cookies').get().c;
    db.close();
    return n === 83;
  })(), '调用后仍是 83 条');
  check('dry-run 报告将删 80 条', dryJson?.wouldRemove === 80, `wouldRemove=${dryJson?.wouldRemove}`);
  check('dry-run 不产生备份文件', !readdirSync(dir).some((f) => f.includes('.bak-')));

  console.log('\n== repair 实跑 ==');
  const real = run(['scripts/repair.mjs', '--db', dbPath, '--yes', '--json']);
  let realJson = null;
  try {
    realJson = JSON.parse(real.stdout);
  } catch {}
  check('repair 正常退出', real.code === 0, `exit=${real.code} ${real.stderr.slice(0, 160)}`);
  check('删除了 80 条', realJson?.removed === 80, `removed=${realJson?.removed}`);
  check('删完剩 0 条', realJson?.remaining === 0, `remaining=${realJson?.remaining}`);
  check('生成了备份文件', (realJson?.backup ? existsSync(realJson.backup) : false), realJson?.backup ? path.basename(realJson.backup) : '无');

  console.log('\n== 清理后复查 ==');
  const after = run(['scripts/diagnose.mjs', '--db', dbPath, '--json']);
  let afterJson = null;
  try {
    afterJson = JSON.parse(after.stdout);
  } catch {}
  check('剩下的是那 3 条普通 cookie', afterJson?.total === 3 && afterJson?.otherCookies === 3, `total=${afterJson?.total}`);
  check('判定变回 healthy', afterJson?.verdict === 'healthy', `verdict=${afterJson?.verdict}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个用例失败`);
process.exit(failures === 0 ? 0 : 1);
