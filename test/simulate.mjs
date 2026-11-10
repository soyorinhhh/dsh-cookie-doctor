/**
 * 复现 + 验证：用和 DSH 完全一致的 cookie 命名规则与鉴权流程跑一遍。
 *
 * 每次「启动」模拟桌面版的两条请求：
 *   1) shell 拿 ?token= 换 303 + Set-Cookie（这条响应会被 Chromium 记进 cookie 库）；
 *   2) welcome backend 把库里该 host 的所有 cookie 拼成 Cookie 头再请求一次。
 * 因为 cookie 不按端口隔离，而 cookie 名字里带的是 host:port 的哈希，
 * 每重启一次库里就多一条，第 2) 步的请求头随之线性增长。
 *
 * 场景 A：不装插件，反复启动 → 请求头越过 16KB → 431（线上症状）。
 * 场景 B：装插件，从零开始反复启动 → 旧 cookie 被过期掉，请求头保持很小。
 * 场景 C：装插件，但机器已经攒了 76 条（已病发）→ 第一次请求即自愈。
 */
import http from 'node:http';
import { request } from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply as applyPlugin } from '../lib/index.js';

const COOKIE_PREFIX = 'dsh-auth-';
const NODE_DEFAULT_MAX_HEADER_BYTES = 16 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SECRET = randomBytes(32);

const encodeBase64Url = (v) =>
  Buffer.from(v).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

/**
 * 上游 requestAudience() 的模型。**两边必须同步**：插件是为它做镜像的，
 * 这里写错就会变成「自己跟自己一致」的自证测试（HTTPS 分支曾因此漏测）。
 * 明文监听 → url.host；TLS 监听 → url.origin（带 https:// 前缀）。
 */
function requestAudience(headers, secure = false) {
  const host = headers?.host;
  if (typeof host !== 'string') return undefined;
  try {
    const url = new URL(`${secure ? 'https:' : 'http:'}//${host}`);
    return secure ? url.origin : url.host;
  } catch {
    return undefined;
  }
}

const cookieName = (authority) =>
  COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest());

function encodeCookie(payload) {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = createHmac('sha256', SECRET).update(body).digest();
  return `${body}.${encodeBase64Url(mac)}`;
}

const sessionCookie = (name, value, expiresAt, maxAgeSeconds) =>
  `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`;

function cookieValue(headerValue, name) {
  if (typeof headerValue !== 'string') return undefined;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1 || segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

/** 假 Chromium cookie 库：同名同域覆盖，不按端口区分。 */
class FakeJar {
  constructor() {
    this.cookies = new Map();
  }
  applySetCookie(headers) {
    const raw = headers['set-cookie'];
    if (raw === undefined) return;
    for (const line of Array.isArray(raw) ? raw : [raw]) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      if (at === -1) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const dead = /Max-Age=0/i.test(line) || /Expires=Thu, 01 Jan 1970/i.test(line);
      if (dead || value.length === 0) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get size() {
    return this.cookies.size;
  }
  seed(count, host) {
    // 真实会话 cookie 的值约 190~220 字节（base64 的 JSON + HMAC）
    const realisticValue = encodeCookie({
      version: 1,
      authority: '127.0.0.1:41000',
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_702_592_000_000
    });
    for (let i = 0; i < count; i++) {
      this.cookies.set(cookieName(`${host}:${10000 + i}`), realisticValue);
    }
  }
}

function createHost({ withPlugin, reportPath, secure = false, useEvent = true }) {
  const launchToken = encodeBase64Url(randomBytes(32));
  const listeners = new Map();

  const handler = (req, res) => {
    const url = new URL(req.url, 'http://dsh.invalid');
    const authority = requestAudience(req.headers, secure);
    const tokens = url.searchParams.getAll('token');

    if (tokens.length > 0) {
      if (req.method === 'GET' && url.pathname === '/' && tokens.length === 1 && tokens[0] === launchToken && authority) {
        const issuedAt = Date.now();
        const expiresAt = issuedAt + MAX_AGE_MS;
        const value = encodeCookie({ version: 1, authority, issuedAt, expiresAt });
        res.writeHead(303, {
          'cache-control': 'no-store',
          location: './',
          'set-cookie': sessionCookie(cookieName(authority), value, expiresAt, Math.floor(MAX_AGE_MS / 1000))
        });
        res.end();
        return;
      }
      res.writeHead(401, { 'cache-control': 'no-store' });
      res.end();
      return;
    }

    const value = authority ? cookieValue(req.headers.cookie, cookieName(authority)) : undefined;
    if (value === undefined) {
      res.writeHead(401, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  };

  const server = http.createServer((req, res) => {
    // 真实 host 里 client-connection 是这么跑的：
    //   webCtx.waterfall('connection/request', req, res, () => bridge(...))
    // 插件现在挂在这个 waterfall 上，所以模拟器也要走同一条路径。
    const chain = listeners.get('connection/request') ?? [];
    if (chain.length === 0) {
      handler(req, res);
      return;
    }
    const composed = chain.reduceRight(
      (next, listener) => () => listener(req, res, next),
      () => handler(req, res)
    );
    Promise.resolve()
      .then(composed)
      .catch((error) => {
        try {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(String(error));
        } catch {}
      });
  });

  if (withPlugin) {
    const ctx = {
      // protocol 是上游 requestAudience() 判断 TLS 的同一来源；
      // 这里换成 https: 就能在纯 http 通道上验证插件的命名分支。
      webServer: { server, protocol: secure ? 'https:' : 'http:' },
      effect: (fn) => fn(),
      logger: { info() {}, warn() {} }
    };
    if (useEvent) {
      // 模拟 Cordis 的事件注册：返回 disposer。
      ctx.on = (event, listener) => {
        if (!listeners.has(event)) listeners.set(event, []);
        const list = listeners.get(event);
        list.push(listener);
        return () => {
          const at = list.indexOf(listener);
          if (at !== -1) list.splice(at, 1);
        };
      };
    }
    applyPlugin(ctx, { reportPath, quiet: true });
  }
  return { server, launchToken };
}

function send(port, { cookie, token, pathname = '/' }) {
  return new Promise((resolve) => {
    const query = token === undefined ? '' : `?token=${token}`;
    const headers = { host: `127.0.0.1:${port}` };
    if (cookie) headers.cookie = cookie;
    const req = request({ host: '127.0.0.1', port, path: `${pathname}${query}`, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, sentBytes: (cookie ?? '').length }));
    });
    req.on('error', (err) => resolve({ status: 0, headers: {}, sentBytes: (cookie ?? '').length, error: String(err.message) }));
    req.end();
  });
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise((r) => server.close(r));

async function launchOnce({ withPlugin, jar, reportPath, secure = false, useEvent = true }) {
  const { server, launchToken } = createHost({ withPlugin, reportPath, secure, useEvent });
  const port = await listen(server);

  // 1) 换 token：带上次遗留的 cookie（cookie 不按端口隔离，会被一起发出去）
  const auth = await send(port, { token: launchToken, cookie: jar.header() });
  jar.applySetCookie(auth.headers);

  // 2) welcome backend：把库里所有 cookie 拼起来再请求
  const welcome = await send(port, { cookie: jar.header() });
  jar.applySetCookie(welcome.headers);

  await close(server);
  return {
    port,
    authStatus: auth.status,
    welcomeStatus: welcome.status,
    requestHeaderBytes: Math.max(auth.sentBytes, welcome.sentBytes),
    jarSize: jar.size
  };
}

async function scenario({ withPlugin, preload, launches, secure = false, useEvent = true }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cookie-doctor-'));
  const reportPath = path.join(dir, 'report.json');
  const jar = new FakeJar();
  if (preload > 0) jar.seed(preload, '127.0.0.1');

  const rows = [];
  let firstFailure = null;
  for (let i = 1; i <= launches; i++) {
    const row = await launchOnce({ withPlugin, jar, reportPath, secure, useEvent });
    rows.push({ launch: i, ...row });
    const broken = row.authStatus !== 303 || row.welcomeStatus !== 200;
    if (firstFailure === null && broken) firstFailure = { launch: i, ...row };
  }

  rmSync(dir, { recursive: true, force: true });
  return { rows, firstFailure };
}

function summarize(title, result) {
  const first = result.rows[0];
  const last = result.rows[result.rows.length - 1];
  const maxBytes = Math.max(...result.rows.map((r) => r.requestHeaderBytes));
  console.log(`\n### ${title}`);
  console.log(`  首次：请求头 ${first.requestHeaderBytes} 字节，库中 ${first.jarSize} 条`);
  console.log(`  末次：请求头 ${last.requestHeaderBytes} 字节，库中 ${last.jarSize} 条`);
  console.log(`  峰值请求头 ${maxBytes} 字节（Node 默认上限 ${NODE_DEFAULT_MAX_HEADER_BYTES}）`);
  if (result.firstFailure) {
    console.log(`  ❌ 第 ${result.firstFailure.launch} 次启动失败：auth=${result.firstFailure.authStatus} welcome=${result.firstFailure.welcomeStatus}，请求头 ${result.firstFailure.requestHeaderBytes} 字节`);
  } else {
    console.log('  ✅ 全程正常');
  }
  return { rows: result.rows, last, maxBytes, failed: result.firstFailure !== null, firstFailure: result.firstFailure };
}

async function main() {
  const A = summarize('A. 不装插件（复现线上故障）', await scenario({ withPlugin: false, preload: 0, launches: 90 }));
  const B = summarize('B. 装插件（从零开始）', await scenario({ withPlugin: true, preload: 0, launches: 90 }));
  const C = summarize('C. 装插件 + 已攒 76 条（病发机器）', await scenario({ withPlugin: true, preload: 76, launches: 5 }));
  console.log(`  C 每次启动后的库中条数：${C.rows.map((r) => r.jarSize).join(' → ')}`);

  // D 验证 TLS 分支：上游对 TLS 监听用 url.origin 当 authority（带 https:// 前缀）。
  // 插件如果只会算 host 形式，就会把当前会话那条当成历史垃圾删掉 → 每轮都掉登录态。
  const D = summarize(
    'D. HTTPS 监听（cookie 名按 origin 计算）',
    await scenario({ withPlugin: true, preload: 0, launches: 4, secure: true })
  );
  console.log(`  D 每次启动后的库中条数：${D.rows.map((r) => r.jarSize).join(' → ')}`);

  // E 验证兜底路径：老版本 host 没有 connection/request 事件时，
  // 插件会退回去直接挂 http.Server 的 request。这条路径不能被改坏。
  const E = summarize(
    'E. 没有 connection/request 事件（走 http.Server 兜底）',
    await scenario({ withPlugin: true, preload: 0, launches: 4, useEvent: false })
  );
  console.log(`  E 每次启动后的库中条数：${E.rows.map((r) => r.jarSize).join(' → ')}`);

  const checks = [
    ['A 必须复现失败', A.failed === true],
    ['A 失败时请求头超过 16KB', A.firstFailure ? A.firstFailure.requestHeaderBytes > NODE_DEFAULT_MAX_HEADER_BYTES : false],
    ['B 全程不得失败', B.failed === false],
    ['B 请求头保持 < 2KB', B.maxBytes < 2048],
    ['B 结束时库里只剩 1 条', B.last.jarSize === 1],
    ['C 病发机器不再失败', C.failed === false],
    ['C 自愈后库里只剩 1 条', C.last.jarSize === 1],
    ['D HTTPS 下不得失败（不能删掉当前 cookie）', D.failed === false],
    ['D HTTPS 下库里稳定剩 1 条', D.last.jarSize === 1],
    ['E 兜底路径不得失败', E.failed === false],
    ['E 兜底路径下库里只剩 1 条', E.last.jarSize === 1]
  ];

  console.log('\n==== 断言 ====');
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    if (!pass) ok = false;
  }
  console.log(ok ? '\n全部通过' : '\n有用例失败');
  process.exit(ok ? 0 : 1);
}

main();
