/**
 * 验证配置校验：写错的名字 / 类型不能被静默吞掉。
 *
 * 这个插件没有 Config schema（引入 schemastery 会破坏「零依赖」的目标），
 * 所以 readOptions() 自己校验。这里断言每种错误都真的被报出来，
 * 并且回落到了默认值 —— 之前的实现是不声不响地回落。
 */
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply as applyPlugin } from '../lib/index.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'cookie-doctor-config-'));
const reportPath = path.join(dir, 'report.json');
// reportPath 本身写错时会回落到 $DSH_HOME，把它也指到临时目录，避免污染真实 home
process.env.DSH_HOME = dir;

let failures = 0;
const check = (label, pass, extra = '') => {
  console.log(`  ${pass ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!pass) failures++;
};

/** 用给定 config 跑一次 apply，收集 warn 日志。 */
function run(config) {
  const warnings = [];
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  applyPlugin(
    {
      webServer: { server, protocol: 'http:' },
      effect: (fn) => fn(),
      logger: { info() {}, warn: (message) => warnings.push(String(message)) }
    },
    config
  );
  server.close();
  return warnings;
}

const hasWarningFor = (warnings, key) => warnings.some((line) => line.includes(key));

try {
  console.log('== 正常配置：不应该有任何警告 ==');
  const clean = run({ reportPath, maxHeaderBytes: 131072, purgeStale: false, warnAuthCookies: 4 });
  check('没有警告', clean.length === 0, clean.join(' | '));

  console.log('\n== 未知配置项 ==');
  const unknown = run({ reportPath, nope: 1, maxHeaderByte: 262144 });
  check('报出未知项 nope', hasWarningFor(unknown, 'nope'), unknown.join(' | '));
  check('拼错的 maxHeaderByte 也被报出来（这是最容易静默失效的场景）', hasWarningFor(unknown, 'maxHeaderByte'));

  console.log('\n== 类型写错 ==');
  const badNumber = run({ reportPath, maxHeaderBytes: '262144' });
  check('maxHeaderBytes 传字符串会报警', hasWarningFor(badNumber, 'maxHeaderBytes'), badNumber.join(' | '));

  const badBool = run({ reportPath, purgeStale: 'false' });
  check('purgeStale 传字符串会报警', hasWarningFor(badBool, 'purgeStale'), badBool.join(' | '));

  const negative = run({ reportPath, maxHeaderBytes: -1 });
  check('maxHeaderBytes 为负会报警', hasWarningFor(negative, 'maxHeaderBytes'), negative.join(' | '));

  const badPath = run({ maxHeaderBytes: 131072 });
  check('reportPath 缺失时用默认路径，不报警', !hasWarningFor(badPath, 'reportPath'), badPath.join(' | '));

  const wrongPath = run({ reportPath: 12345 });
  check('reportPath 类型错会报警', hasWarningFor(wrongPath, 'reportPath'), wrongPath.join(' | '));

  console.log('\n== 回落值真的生效 ==');
  const applied = path.join(dir, 'applied.json');
  run({ reportPath: applied, maxHeaderBytes: 131072 });
  let report = null;
  try {
    report = JSON.parse(readFileSync(applied, 'utf8'));
  } catch {}
  check('合法值被应用（131072）', report?.maxHeaderBytesApplied === 131072, `实际 ${report?.maxHeaderBytesApplied}`);

  const fallback = path.join(dir, 'fallback.json');
  run({ reportPath: fallback, maxHeaderBytes: 'not-a-number' });
  let report2 = null;
  try {
    report2 = JSON.parse(readFileSync(fallback, 'utf8'));
  } catch {}
  check('非法值回落到 262144', report2?.maxHeaderBytesApplied === 262144, `实际 ${report2?.maxHeaderBytesApplied}`);
} finally {
  delete process.env.DSH_HOME;
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个用例失败`);
process.exit(failures === 0 ? 0 : 1);
