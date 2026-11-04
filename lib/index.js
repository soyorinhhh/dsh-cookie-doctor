/**
 * dsh-cookie-doctor — 修 DSH 桌面版「Web authentication failed」死循环的 host 插件。
 *
 * 病因（0.2.0-rc.2 / 0.2.1-rc.3 都在）：
 *   dsh-client-connection 的会话 cookie 名字是
 *       dsh-auth- + base64url(sha256(requestAuthority))
 *   而 requestAuthority 取的是请求头里的 host，即 `127.0.0.1:<每次启动随机端口>`。
 *   Cookie 又不按端口隔离，于是每重启一次就多一条永不失效的新名字 cookie，
 *   攒到服务端 header 超过 Node 默认的 16KB 上限 → 431 → Electron 报认证失败。
 *
 * 本插件在 host 进程里接管 http.Server：
 *   1. 把 maxHeaderSize 抬到 256KB，让「已经攒了几十条」的机器仍然能起来；
 *   2. 每条请求都会把本轮 authority 之外的所有 dsh-auth-* cookie 用
 *      Set-Cookie + Max-Age=0 过期掉，让 Chromium 自己清理，cookie 数回到 1~2 条；
 *   3. 把统计写进 ~/.dsh/cookie-doctor/report.json，便于确认到底有没有生效。
 *
 * 不引入任何依赖，只用 node 内置模块，保证装到任何 profile 下都能直接解析。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const name = 'dsh-cookie-doctor';

/** webServer 服务由 @deepseek-ai/dsh-host-webserver 提供；缺失时插件自动休眠。 */
export const inject = ['webServer'];

const COOKIE_PREFIX = 'dsh-auth-';
const NODE_DEFAULT_MAX_HEADER_BYTES = 16 * 1024;

/** 与 dsh-client-connection 中 cookieName()/requestAuthority() 保持逐字节一致。 */
function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function requestAuthority(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return undefined;
  try {
    return new URL(`http://${hostHeader}`).host;
  } catch {
    return undefined;
  }
}

function cookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest());
}

/** 从 Cookie 头里取出名字列表（值不解析，只需要名字）。 */
function cookieNames(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.length === 0) return [];
  const names = [];
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    const name = segment.slice(0, at).trim();
    if (name.length > 0) names.push(name);
  }
  return names;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function deletionHeader(cookieNameValue) {
  return `${cookieNameValue}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Strict`;
}

/**
 * 在 res.writeHead 上挂一层，把过期用的 Set-Cookie 合并进这次响应。
 * 不能用 res.setHeader 直接设：dsh-client-connection 是把 set-cookie 放在
 * writeHead 的 headers 参数里传的，会覆盖先前 setHeader 的值。
 */
function injectDeletions(res, names) {
  const extra = names.map(deletionHeader);
  if (extra.length === 0) return;
  const original = res.writeHead;
  if (typeof original !== 'function') return;

  res.writeHead = function patchedWriteHead(statusCode, statusMessageOrHeaders, maybeHeaders) {
    res.writeHead = original;
    try {
      let headers;
      if (statusMessageOrHeaders !== null && typeof statusMessageOrHeaders === 'object') {
        headers = statusMessageOrHeaders;
      } else if (maybeHeaders !== null && typeof maybeHeaders === 'object') {
        headers = maybeHeaders;
      }
      const merged = [
        ...asArray(res.getHeader('set-cookie')),
        ...asArray(headers?.['set-cookie'] ?? headers?.['Set-Cookie']),
        ...extra
      ];
      if (headers !== undefined && headers !== null) {
        delete headers['set-cookie'];
        delete headers['Set-Cookie'];
      }
      res.setHeader('set-cookie', merged);
    } catch {
      // 合并失败也绝不能影响正常响应，退回原样发送。
    }
    return original.apply(res, arguments);
  };
}

function defaultReportPath() {
  // 跟 DSH 自己的 home 走：桌面版默认 ~/.dsh，测试/多实例时可用 DSH_HOME 覆盖
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'cookie-doctor', 'report.json');
}

function readOptions(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const maxHeaderBytes = Number.isFinite(raw.maxHeaderBytes) && raw.maxHeaderBytes >= 0
    ? Math.trunc(raw.maxHeaderBytes)
    : 256 * 1024;
  return {
    /** 0 表示完全不改 Node 的默认上限。 */
    maxHeaderBytes,
    purgeStale: raw.purgeStale !== false,
    maxPurgePerResponse: Number.isFinite(raw.maxPurgePerResponse) && raw.maxPurgePerResponse > 0
      ? Math.trunc(raw.maxPurgePerResponse)
      : 200,
    reportPath: typeof raw.reportPath === 'string' && raw.reportPath.length > 0
      ? raw.reportPath
      : defaultReportPath(),
    warnAuthCookies: Number.isFinite(raw.warnAuthCookies) && raw.warnAuthCookies > 0
      ? Math.trunc(raw.warnAuthCookies)
      : 8,
    quiet: raw.quiet === true
  };
}

function makeLogger(ctx, quiet) {
  const sink = (level, message) => {
    if (quiet) return;
    try {
      const logger = ctx?.logger;
      if (logger && typeof logger[level] === 'function') {
        logger[level](`[cookie-doctor] ${message}`);
        return;
      }
    } catch {}
    try {
      // 兜底：host 进程的 stdout 会被桌面版收进诊断缓冲区
      console.log(`[cookie-doctor] ${message}`);
    } catch {}
  };
  return {
    info: (message) => sink('info', message),
    warn: (message) => sink('warn', message)
  };
}

function createReporter(options, logger) {
  const startedAt = Date.now();
  const report = {
    plugin: name,
    pid: process.pid,
    startedAt: new Date(startedAt).toISOString(),
    maxHeaderBytesApplied: 0,
    nodeDefaultMaxHeaderBytes: NODE_DEFAULT_MAX_HEADER_BYTES,
    requests: 0,
    purgeEvents: 0,
    purgedCookies: 0,
    maxCookieHeaderBytes: 0,
    maxAuthCookies: 0,
    authCookies: 0,
    host: null,
    authority: null,
    currentCookieName: null,
    warned: false,
    lastError: null
  };
  let lastWrite = 0;
  let dirty = false;

  const flush = (force) => {
    const now = Date.now();
    if (!dirty && !force) return;
    if (!force && now - lastWrite < 4000) return;
    lastWrite = now;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(options.reportPath), { recursive: true });
      fs.writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    } catch (error) {
      report.lastError = String(error && error.message ? error.message : error);
    }
  };

  return {
    report,
    observe({ bytes, names, authNames, host }) {
      report.requests += 1;
      report.host = host ?? report.host;
      if (bytes > report.maxCookieHeaderBytes) report.maxCookieHeaderBytes = bytes;
      if (authNames.length > report.maxAuthCookies) report.maxAuthCookies = authNames.length;
      report.authCookies = authNames.length;
      dirty = true;
      if (!report.warned && authNames.length >= options.warnAuthCookies) {
        report.warned = true;
        logger.warn(
          `检测到 ${authNames.length} 条 dsh-auth-* cookie（Cookie 头 ${bytes} 字节），` +
            `已超过警戒线 ${options.warnAuthCookies} 条。插件会尝试逐条过期它们；` +
            '若重启后仍报 Web authentication failed，请运行 scripts/repair.mjs 清理。'
        );
      }
      flush(false);
    },
    recordPurge(count) {
      report.purgeEvents += 1;
      report.purgedCookies += count;
      dirty = true;
      flush(false);
    },
    setInstance(info) {
      report.maxHeaderBytesApplied = info.maxHeaderBytesApplied;
      report.nodeDefaultMaxHeaderBytes = info.nodeDefaultMaxHeaderBytes;
      dirty = true;
      flush(true);
    },
    flush
  };
}

function attach(server, ctx, options, logger, reporter) {
  let restoreMaxHeader = () => {};
  if (options.maxHeaderBytes > 0) {
    const previous = server.maxHeaderSize;
    try {
      server.maxHeaderSize = options.maxHeaderBytes;
      restoreMaxHeader = () => {
        server.maxHeaderSize = previous;
      };
    } catch (error) {
      logger.warn(`无法调整 maxHeaderSize：${error && error.message ? error.message : error}`);
    }
  }

  const onRequest = (req, res) => {
    const cookieHeader = req.headers?.cookie;
    const names = cookieNames(cookieHeader);
    const authNames = names.filter((entry) => entry.startsWith(COOKIE_PREFIX));
    const authority = requestAuthority(req.headers?.host);
    const current = authority === undefined ? undefined : cookieName(authority);

    reporter.report.authority = authority ?? reporter.report.authority;
    reporter.report.currentCookieName = current ?? reporter.report.currentCookieName;
    reporter.observe({
      bytes: typeof cookieHeader === 'string' ? cookieHeader.length : 0,
      names,
      authNames,
      host: req.headers?.host
    });

    if (!options.purgeStale || current === undefined || authNames.length === 0) return;
    const stale = [];
    for (const entry of authNames) {
      if (entry === current) continue;
      if (stale.length >= options.maxPurgePerResponse) break;
      stale.push(entry);
    }
    if (stale.length === 0) return;
    injectDeletions(res, stale);
    reporter.recordPurge(stale.length);
  };

  server.prependListener('request', onRequest);
  reporter.setInstance({
    maxHeaderBytesApplied: server.maxHeaderSize,
    nodeDefaultMaxHeaderBytes: NODE_DEFAULT_MAX_HEADER_BYTES
  });
  logger.info(
    `已接管 host HTTP 通道：maxHeaderSize ${NODE_DEFAULT_MAX_HEADER_BYTES} → ${server.maxHeaderSize}，` +
      `过期策略 ${options.purgeStale ? '开启' : '关闭'}，报告 ${options.reportPath}`
  );

  return () => {
    server.off('request', onRequest);
    restoreMaxHeader();
    reporter.flush(true);
  };
}

function attachWhenReady(ctx, options, logger, reporter, deadlineMs = 20000) {
  let disposer = null;
  let stopped = false;
  const startedAt = Date.now();

  const tryAttach = () => {
    if (stopped || disposer !== null) return;
    const server = ctx.webServer?.server;
    if (server !== undefined && server !== null && typeof server.prependListener === 'function') {
      try {
        disposer = attach(server, ctx, options, logger, reporter);
      } catch (error) {
        logger.warn(`接管失败：${error && error.message ? error.message : error}`);
      }
      return;
    }
    if (Date.now() - startedAt > deadlineMs) {
      logger.warn('等待 webServer.server 超时，插件保持休眠');
      return;
    }
    setTimeout(tryAttach, 25).unref?.();
  };

  tryAttach();

  return () => {
    stopped = true;
    if (typeof disposer === 'function') disposer();
  };
}

export function apply(ctx, config) {
  // 插件在 host 启动时加载；这里任何异常都可能被当成 fiber 失败导致 DSH 起不来，
  // 所以整体兜一层：宁可这个插件什么都不做，也绝不能拖垮启动。
  let dispose = () => {};
  try {
    const options = readOptions(config);
    const logger = makeLogger(ctx, options.quiet);
    const reporter = createReporter(options, logger);
    dispose = attachWhenReady(ctx, options, logger, reporter);
  } catch (error) {
    try {
      console.warn(`[cookie-doctor] 初始化失败，已跳过：${error && error.stack ? error.stack : error}`);
    } catch {}
    return;
  }

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => dispose);
    } else if (typeof ctx.on === 'function') {
      ctx.on('dispose', () => dispose());
    }
  } catch (error) {
    try {
      console.warn(`[cookie-doctor] 注册清理钩子失败：${error && error.message ? error.message : error}`);
    } catch {}
  }
}
