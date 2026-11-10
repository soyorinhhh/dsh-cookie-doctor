/**
 * dsh-cookie-doctor — 修 DSH 桌面版「Web authentication failed」死循环的 host 插件。
 *
 * 病因（0.2.0-rc.2 / 0.2.1-rc.3 都在）：
 *   dsh-client-connection 的会话 cookie 名字是
 *       dsh-auth- + base64url(sha256(requestAudience))
 *   而 requestAudience 取的是请求头里的 host，即 `127.0.0.1:<每次启动随机端口>`。
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

/** 与 dsh-client-connection 中 cookieName()/requestAudience() 保持逐字节一致。 */
function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

/**
 * 与 dsh-client-connection 的 requestAudience() 逐字节一致，**包括 TLS 分支**：
 * 明文监听返回 `url.host`（host:port），TLS 监听返回 `url.origin`（带 https:// 前缀）。
 * 少写这个分支的后果不是「少清理一条」：算出来的名字永远对不上真实的 cookie 名，
 * 每次响应都会把当前会话的那条当成历史垃圾删掉，TLS 部署直接 401 死循环。
 */
function requestAudience(hostHeader, secure) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return undefined;
  try {
    const url = new URL(`${secure ? 'https:' : 'http:'}//${hostHeader}`);
    return secure ? url.origin : url.host;
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

const KNOWN_CONFIG_KEYS = [
  'maxHeaderBytes',
  'purgeStale',
  'maxPurgePerResponse',
  'reportPath',
  'warnAuthCookies',
  'quiet'
];

const DEFAULT_MAX_HEADER_BYTES = 256 * 1024;
const DEFAULT_MAX_PURGE = 200;
const DEFAULT_WARN_COOKIES = 8;

function readOptions(config, logger) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const warn = (message) => {
    try {
      logger?.warn(`${message}`);
    } catch {}
  };

  if (config !== undefined && config !== null && typeof config !== 'object') {
    warn(`config 应该是对象，实际是 ${typeof config}，全部按默认值处理`);
  }

  // 这个插件没有 Config schema（加上 schemastery 会破坏「零依赖」），
  // 所以校验只能自己做。至少要保证：写错的名字 / 写错的类型不会被静默吞掉。
  for (const key of Object.keys(raw)) {
    if (!KNOWN_CONFIG_KEYS.includes(key)) {
      warn(`未知配置项 ${key}，已忽略。可用项：${KNOWN_CONFIG_KEYS.join(', ')}`);
    }
  }

  const pickNumber = (key, fallback, isValid) => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || !isValid(value)) {
      warn(`配置项 ${key} 的取值 ${JSON.stringify(value)} 不合法，已回落到 ${fallback}`);
      return fallback;
    }
    return Math.trunc(value);
  };

  const pickBoolean = (key, fallback) => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      warn(`配置项 ${key} 应该是布尔值，实际是 ${JSON.stringify(value)}，已回落到 ${fallback}`);
      return fallback;
    }
    return value;
  };

  const maxHeaderBytes = pickNumber('maxHeaderBytes', DEFAULT_MAX_HEADER_BYTES, (v) => v >= 0);
  const maxPurgePerResponse = pickNumber('maxPurgePerResponse', DEFAULT_MAX_PURGE, (v) => v > 0);
  const warnAuthCookies = pickNumber('warnAuthCookies', DEFAULT_WARN_COOKIES, (v) => v > 0);

  let reportPath = defaultReportPath();
  if (raw.reportPath !== undefined) {
    if (typeof raw.reportPath === 'string' && raw.reportPath.length > 0) {
      reportPath = raw.reportPath;
    } else {
      warn(`配置项 reportPath 应该是非空字符串，实际是 ${JSON.stringify(raw.reportPath)}，已用默认路径`);
    }
  }

  return {
    /** 0 表示完全不改 Node 的默认上限。 */
    maxHeaderBytes,
    purgeStale: pickBoolean('purgeStale', true),
    maxPurgePerResponse,
    reportPath,
    warnAuthCookies,
    quiet: pickBoolean('quiet', false)
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
    secure: false,
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

/**
 * 在 webServer 服务上定位 http.Server。
 *
 * 服务契约（cordis_inspect 的 Service.webServer）并没有承诺暴露底层 server，
 * 所以这里不硬编码某一个字段名：先看惯用的 server，再按「http.Server 的形状」
 * 扫一遍自有属性。找不到也不致命 —— 清理挂的是文档化事件，见 attach()。
 */
function findHttpServer(webServer) {
  if (webServer === undefined || webServer === null) return undefined;
  // 注意不能要求 maxHeaderSize 是 number：Node 没配过上限时它是 undefined，
  // 只要求这个属性存在（http.Server / https.Server 都会在构造时挂上它）。
  const isServerLike = (value) =>
    value !== null &&
    typeof value === 'object' &&
    typeof value.on === 'function' &&
    typeof value.prependListener === 'function' &&
    typeof value.listen === 'function' &&
    'maxHeaderSize' in value;

  let named;
  try {
    named = webServer.server;
  } catch {
    named = undefined;
  }
  if (isServerLike(named)) return named;

  try {
    for (const key of Object.getOwnPropertyNames(webServer)) {
      const value = webServer[key];
      if (isServerLike(value)) return value;
    }
  } catch {}
  return undefined;
}

function attach(ctx, options, logger, reporter) {
  const disposers = [];
  let restoreMaxHeader = () => {};

  const applyMaxHeader = (target, how) => {
    if (target === undefined || options.maxHeaderBytes <= 0) return;
    const previous = target.maxHeaderSize;
    try {
      target.maxHeaderSize = options.maxHeaderBytes;
      restoreMaxHeader = () => {
        target.maxHeaderSize = previous;
      };
      reporter.setInstance({
        maxHeaderBytesApplied: target.maxHeaderSize,
        nodeDefaultMaxHeaderBytes: NODE_DEFAULT_MAX_HEADER_BYTES
      });
      logger.info(
        `已抬高 maxHeaderSize ${NODE_DEFAULT_MAX_HEADER_BYTES} → ${target.maxHeaderSize}（${how}）`
      );
    } catch (error) {
      logger.warn(`无法调整 maxHeaderSize：${error && error.message ? error.message : error}`);
    }
  };

  let server = findHttpServer(ctx.webServer);
  applyMaxHeader(server, 'webServer');

  // 监听是否为 TLS：这是上游 requestAudience() 用的同一个判据（webServer.protocol）。
  // listen 一旦绑定就不会再变，取一次即可。
  let secure = false;
  try {
    secure = ctx.webServer?.protocol === 'https:';
  } catch {
    secure = false;
  }
  reporter.report.secure = secure;
  if (secure) {
    logger.info('检测到 TLS 监听，cookie 名将按 origin（https://host:port）计算');
  }

  const onRequest = (req, res) => {
    const cookieHeader = req.headers?.cookie;
    const names = cookieNames(cookieHeader);
    const authNames = names.filter((entry) => entry.startsWith(COOKIE_PREFIX));
    const authority = requestAudience(req.headers?.host, secure);
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

  // 首选挂载点：connection/request（文档化的 waterfall 事件，见 cordis_inspect 的 Event 目录）。
  // 直接改 host 的 http.Server 能覆盖全部请求，但服务契约里并没有 server 这一项，
  // 上游一旦改内部结构就会静默失效；事件是公开契约，稳得多。
  let hooked = false;
  try {
    if (typeof ctx.on === 'function') {
      const off = ctx.on('connection/request', async (request, response, next) => {
        try {
          onRequest(request, response);
        } catch (error) {
          // 清理失败绝不能影响这次请求本身
          logger.warn(`清理失败（不影响本次请求）：${error && error.message ? error.message : error}`);
        }
        return next();
      });
      if (typeof off === 'function') disposers.push(off);
      hooked = true;
    }
  } catch (error) {
    logger.warn(`挂载 connection/request 失败：${error && error.message ? error.message : error}`);
  }

  // 兜底：老版本没有这个事件时，直接挂 http.Server 的 request。
  if (!hooked && server !== undefined) {
    server.prependListener('request', onRequest);
    disposers.push(() => {
      server.off('request', onRequest);
    });
    hooked = true;
  }

  if (!hooked) {
    logger.warn('既挂不上 connection/request 也拿不到 http.Server，插件保持休眠');
  }

  // server 可能还没建好：限时补一次 maxHeaderSize。
  // 这一步只决定「已经攒了几十条的机器还能不能起来」，清理本身不依赖它。
  if (server === undefined && options.maxHeaderBytes > 0) {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const found = findHttpServer(ctx.webServer);
      if (found !== undefined) {
        clearInterval(timer);
        applyMaxHeader(found, '延迟发现的 webServer.server');
        return;
      }
      if (Date.now() - startedAt > 20000) {
        clearInterval(timer);
        logger.warn('等待 webServer.server 超时，未调整 maxHeaderSize');
      }
    }, 25);
    timer.unref?.();
    disposers.push(() => clearInterval(timer));
  }

  logger.info(
    `已接管 host HTTP 通道：清理挂载于 ${hooked ? 'connection/request' : '（未挂上）'}，` +
      `过期策略 ${options.purgeStale ? '开启' : '关闭'}，报告 ${options.reportPath}`
  );

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {}
    }
    restoreMaxHeader();
    reporter.flush(true);
  };
}

export function apply(ctx, config) {
  // 插件在 host 启动时加载；这里任何异常都可能被当成 fiber 失败导致 DSH 起不来，
  // 所以整体兜一层：宁可这个插件什么都不做，也绝不能拖垮启动。
  let dispose = () => {};
  try {
    // quiet 决定日志器本身，所以先粗读一次；真正的类型校验在 readOptions 里做，
    // 校验失败会通过这个 logger 明确报出来，而不是悄悄回落默认值。
    const quiet = config !== null && typeof config === 'object' && config.quiet === true;
    const logger = makeLogger(ctx, quiet);
    const options = readOptions(config, logger);
    const reporter = createReporter(options, logger);
    // inject 保证 webServer 在；万一没挂上也只是少抬一个上限，不影响 host 启动。
    dispose = attach(ctx, options, logger, reporter);
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
