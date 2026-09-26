// dsh-workspace-acl-allow — 为工作区目录预置 Windows ACL 完全控制 ACE。
//
// 背景：dsh 启动受限 worker 前，须对工作区根目录调用一次 SetNamedSecurityInfoW，
// 同时写入 DACL 与 Low 强制标签。标签位于 SACL，而 owner 的隐式权限只覆盖
// READ_CONTROL 与 WRITE_DAC，因此该调用要求调用者对目录拥有 WRITE_OWNER；
// 只授予 Modify 的目录会以 Win32 5（拒绝访问）失败，worker 启动即死。
//
// 本插件在宿主进程内向用户**显式声明**的目录补一条 (OI)(CI)F 的 allow ACE
// （F 含 WRITE_OWNER），使宿主自身那次组合调用得以通过。插件不实现宿主的授权
// 逻辑：不碰能力 SID、不写强制标签、不改 owner、不撤销任何 ACE。
//
// 触发仅两条，均为用户显式意图：① 工作区域新增记录（用户在 dsh 添加工作区）；
// ② 插件设置页手动新增路径。不监听会话创建，也不接管任何会话 cwd。
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Schema from "@deepseek-ai/schemastery";

// cordis 服务名，必须与 cordis.patch.yml 的 insert.id 一致。
export const name = "workspace-acl-allow";

// 静态声明依赖：webServer 承载设置页的同源路由，webRuntime 提供可信来源清单。
// 依赖就绪前 fiber 处于等待态而非失败态；这与宿主既有插件（内存宫）的写法一致。
export const inject = ["webServer", "webRuntime"];

const execFileAsync = promisify(execFile);

const DOMAIN_NAME = "workspace";
const TABLE_NAME = "workspaces";
const PACKAGE_NAME = "dsh-workspace-acl-allow";
const ROUTE_PREFIX = "/workspace-acl-allow";
const STATE_DIR_NAME = PACKAGE_NAME;
const STATE_FILE_NAME = "state.json";

/** 授权模板：完全控制，含 WRITE_OWNER，与宿主成功路径留下的形态一致。 */
const GRANT_TEMPLATE = "(OI)(CI)F";

const IS_WINDOWS = process.platform === "win32";

// 字段一律不加 volatile：不同 profile 解析到的是不同的 schemastery 副本——
// web profile 落到 profile 自带的旧副本（无该 API），desktop profile 落到全局安装
// 内嵌的新副本（有该 API）。加了会让 web 侧在加载时抛错，不加则两边都能加载。
// 代价是配置项不经设置页写回，作为安装期开关由 profile 配置层维护。
// 读值一律经 unwrap()：无论宿主是否把字段包装成引用都能正确取值。
export const Config = Schema.object({
  watchWorkspaces: Schema.boolean()
    .default(true)
    .description("订阅工作区新增事件：在 dsh 中添加工作区时自动完成授权。"),
  deepGrant: Schema.boolean()
    .default(false)
    .description("icacls 是否附加 /T 递归处理子项。仅在子目录继承被破坏时开启。"),
  retryCooldownMs: Schema.number()
    .default(3600000)
    .description("授权失败项的冷却时间（毫秒）；冷却内不重试，避免重复触发。"),
  excludePaths: Schema.array(Schema.string())
    .default([])
    .description("追加的排除模式（支持 * 与 ** 通配）。只能追加，不能解除内置系统目录保护。"),
});

// ---- 同源与可信来源围栏 ----
// 这些路由开在本机 HTTP 面上：必须拒绝跨站与不可信 Host 发起的请求，
// 否则任意本机页面或进程都能借道触发一次目录授权。

function headerValue(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127"
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** 可信条目未带端口时只比主机名，带端口时比完整 authority。 */
function authorityMatches(hostUrl, entry) {
  const raw = String(entry).trim();
  if (raw.length === 0) return false;
  let entryUrl;
  try {
    entryUrl = new URL(`http://${raw}`);
  } catch {
    return false;
  }
  return /:\d+$/.test(raw) ? entryUrl.host === hostUrl.host : entryUrl.hostname === hostUrl.hostname;
}

function isTrustedRequest(request, trustedHosts) {
  const host = headerValue(request?.headers, "host");
  if (typeof host !== "string" || host.length === 0) return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const trusted = Array.isArray(trustedHosts) ? trustedHosts : [];
  if (!isLoopbackHostname(hostUrl.hostname) && !trusted.some((entry) => authorityMatches(hostUrl, entry))) {
    return false;
  }
  if (headerValue(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = headerValue(request.headers, "origin");
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/** 解包 volatile 配置引用；直接给值时原样返回，两种形态都能读。 */
function unwrap(value) {
  if (value === null || typeof value !== "object") return value;
  if (typeof value.get === "function" && !Array.isArray(value)) return unwrap(value.get());
  return value;
}

// ---- 路径规范化 ----

/**
 * 规范化到真实路径：符号链接、短名、大小写别名收敛为一种拼写。
 * 规范化只服务于本插件自己的去重键与黑名单比对基准——ACL 操作由 Windows
 * 自行解析路径，拼写差异不影响授权本身能否成功。
 * @param {string} target - 目标路径。
 * @returns {string|null} 真实路径；路径不存在时返回 null。
 */
function canonicalize(target) {
  try {
    return realpathSync.native(target);
  } catch {
    return null;
  }
}

/** 比较用的归一形式：统一小写，去掉末尾多余分隔符（保留盘符根）。 */
function normalizeForCompare(target) {
  const lowered = target.replace(/\//g, "\\").toLowerCase();
  if (/^[a-z]:\\$/.test(lowered)) return lowered;
  return lowered.replace(/\\+$/, "");
}

// ---- 内置黑名单（配置与 UI 均不可解除） ----

/**
 * 内置拒绝清单分两类，语义不同，不能混：
 * - `tree`：自身及其子目录全拒——系统安装目录、程序目录、程序数据目录。
 * - `self`：仅拒自身——用户配置文件根。其下目录（如 .dsh / .codebuddy 等）是正常的
 *   工作区位置，整棵子树一并拒掉会误伤。
 * 盘符根与回收站/系统卷信息不在此列，由 isBuiltinDenied 直接判定。
 * @returns 两类规范化后的拒绝集合。
 */
function builtinDenyList() {
  const tree = [];
  const self = [];
  const push = (list, value) => {
    if (typeof value === "string" && value.trim().length > 0) list.push(value.trim());
  };
  push(tree, process.env.SystemRoot);
  push(tree, process.env.windir);
  push(tree, process.env.ProgramFiles);
  push(tree, process.env["ProgramFiles(x86)"]);
  push(tree, process.env.ProgramData);
  push(self, process.env.USERPROFILE);

  const normalize = (value) => {
    const resolved = resolve(value);
    const real = canonicalize(resolved);
    return normalizeForCompare(real ?? resolved);
  };
  return { tree: new Set(tree.map(normalize)), self: new Set(self.map(normalize)) };
}

/** 内置拒绝：盘符根、系统目录、用户配置文件根、回收站与系统卷信息。 */
function isBuiltinDenied(canonicalPath) {
  const target = normalizeForCompare(canonicalPath);
  if (/^[a-z]:\\?$/.test(target)) return true;
  const segments = target.split("\\");
  const leaf = segments[segments.length - 1] ?? "";
  if (leaf === "$recycle.bin" || leaf === "system volume information") return true;
  const { tree, self } = builtinDenyList();
  if (self.has(target)) return true;
  for (const denied of tree) {
    if (target === denied || target.startsWith(denied + "\\")) return true;
  }
  return false;
}

/** 把简单通配模式编译为正则：** 跨分隔符，* 不跨分隔符。 */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^\\\\]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^\\\\]");
  return new RegExp("^" + source + "$", "i");
}

function isConfiguredDenied(canonicalPath, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const target = normalizeForCompare(canonicalPath);
  for (const raw of patterns) {
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    let compiled;
    try {
      compiled = globToRegExp(normalizeForCompare(resolve(raw)).replace(/\\+$/, ""));
    } catch {
      continue;
    }
    if (compiled.test(target)) return true;
  }
  return false;
}

// ---- 落盘状态（插件自有 JSON，位置由宿主 home-paths 解析，不硬编码） ----

function stateDir() {
  const home = resolveDshHome();
  return join(home, STATE_DIR_NAME);
}

/** 解析 harness home：显式 > $DSH_HOME > ~/.dsh（与宿主同一套优先级）。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
  return join(homedir(), ".dsh");
}

function stateFilePath() {
  return join(stateDir(), STATE_FILE_NAME);
}

function loadState(logger) {
  const file = stateFilePath();
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const records = parsed.records;
    if (records === null || typeof records !== "object" || Array.isArray(records)) return {};
    return records;
  } catch (error) {
    // 状态文件损坏不影响授权能力，只丢失跨重启短路；从空状态继续。
    logger.warn(`state file is unreadable, starting empty: ${String(error)}`);
    return {};
  }
}

/** 原子写：先写临时文件再 rename，避免中断留下半截 JSON。 */
function saveState(records, logger) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    const file = stateFilePath();
    const temp = file + ".tmp";
    const payload = { unit: { name: PACKAGE_NAME, version: 1 }, records };
    writeFileSync(temp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(temp, file);
    return true;
  } catch (error) {
    logger.warn(`state file write failed: ${String(error)}`);
    return false;
  }
}

// ---- 当前用户 SID ----

let cachedSid;

/** 取当前进程用户的 SID；SID 文本与系统语言无关，icacls 用 *SID 形式可免除名称歧义。 */
async function currentUserSid() {
  if (cachedSid !== undefined) return cachedSid;
  cachedSid = null;
  try {
    const { stdout } = await execFileAsync("whoami", ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
    const matched = /S-\d-(?:\d+-)+\d+/.exec(String(stdout));
    if (matched !== null) cachedSid = matched[0];
  } catch {
    cachedSid = null;
  }
  return cachedSid;
}

/** icacls 的受托者写法：优先 SID，取不到时退回 域\用户名。 */
async function granteeSpec() {
  const sid = await currentUserSid();
  if (typeof sid === "string" && sid.length > 0) return `*${sid}`;
  const domain = process.env.USERDOMAIN;
  const username = process.env.USERNAME;
  if (typeof username === "string" && username.length > 0) {
    return typeof domain === "string" && domain.length > 0 ? `${domain}\\${username}` : username;
  }
  return null;
}

// ---- 授权执行 ----

async function runGrant(canonicalPath, deepGrant) {
  const grantee = await granteeSpec();
  if (grantee === null) {
    return { status: "failed:no-grantee", lastError: "cannot resolve current user identity" };
  }
  const args = [canonicalPath, "/grant", `${grantee}:${GRANT_TEMPLATE}`];
  if (deepGrant) args.push("/T");
  try {
    await execFileAsync("icacls", args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return { status: "granted" };
  } catch (error) {
    // 只看退出码，不解析本地化输出；输出原文仅留作诊断。
    const code = error?.code === undefined ? "exec" : String(error.code);
    const detail = String(error?.stderr ?? error?.message ?? "").trim().slice(0, 400);
    return { status: `failed:${code}`, lastError: detail };
  }
}

// ---- 插件主体 ----

/**
 * 打开一次插件实例。所有状态与副作用都由返回的句柄持有，fiber 卸载即失效。
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - 已校验的 Config 实例（字段为 volatile 引用）。
 */
export function apply(ctx, config) {
  const logger = ctx.logger;

  if (!IS_WINDOWS) {
    logger.warn("non-Windows platform: inactive (workspace ACL bootstrapping is Windows-only)");
    return;
  }

  let records = loadState(logger);
  const hot = new Map();
  const pending = new Map();

  const readConfig = () => ({
    watchWorkspaces: unwrap(config.watchWorkspaces) !== false,
    deepGrant: unwrap(config.deepGrant) === true,
    retryCooldownMs: Number(unwrap(config.retryCooldownMs)) || 3600000,
    excludePaths: unwrap(config.excludePaths) ?? [],
  });

  const persist = () => { saveState(records, logger); };

  const recordFor = (canonicalPath) => records[canonicalPath] ?? null;

  function store(canonicalPath, entry) {
    records[canonicalPath] = entry;
    hot.set(canonicalPath, entry);
    persist();
  }

  /**
   * 幂等入口：三级短路（内存 → 落盘 granted → 执行 icacls）。
   * @param {string} target - 待授权目录。
   * @param {string} reason - 触发来源，仅用于日志。
   * @param {boolean} force - 忽略短路强制重跑（设置页「重新授权」用）。
   * @returns {Promise<object>} 该目录的最新状态记录。
   */
  async function ensureAcl(target, reason, force = false) {
    if (!IS_WINDOWS) return { status: "skipped:not-windows", at: Date.now(), attempts: 0 };
    if (typeof target !== "string" || target.trim().length === 0) {
      return { status: "skipped:empty", at: Date.now(), attempts: 0 };
    }

    const resolved = resolve(target.trim());
    const canonicalPath = canonicalize(resolved);
    if (canonicalPath === null) {
      logger.info(`[${reason}] skipped:missing ${resolved}`);
      return { status: "skipped:missing", at: Date.now(), attempts: 0 };
    }

    const inFlight = pending.get(canonicalPath);
    if (inFlight !== undefined && !force) return inFlight;

    const run = (async () => {
      const { deepGrant, retryCooldownMs, excludePaths } = readConfig();

      if (!force) {
        const cached = hot.get(canonicalPath);
        if (cached !== undefined && cached.status === "granted") return cached;
        const stored = recordFor(canonicalPath);
        if (stored !== null && stored.status === "granted") {
          hot.set(canonicalPath, stored);
          return stored;
        }
      }

      // skipped:* 是确定性的（由路径与配置即可推出），不落盘也不进热缓存：
      // 落盘清单只承载「已声明并尝试授权过」的目录，即 granted 与 failed。
      if (isBuiltinDenied(canonicalPath) || isConfiguredDenied(canonicalPath, excludePaths)) {
        logger.warn(`[${reason}] skipped:blacklist ${canonicalPath}`);
        return { status: "skipped:blacklist", at: Date.now(), attempts: 0 };
      }

      const previous = recordFor(canonicalPath);
      if (!force && previous !== null && typeof previous.status === "string"
        && previous.status.startsWith("failed:")
        && typeof previous.at === "number" && Date.now() - previous.at < retryCooldownMs) {
        return previous;
      }

      const result = await runGrant(canonicalPath, deepGrant);
      const entry = {
        status: result.status,
        at: Date.now(),
        attempts: (previous?.attempts ?? 0) + 1,
        ...result.lastError === undefined ? {} : { lastError: result.lastError },
      };
      if (result.status === "granted") {
        logger.info(`[${reason}] granted ${canonicalPath}`);
      } else {
        logger.warn(`[${reason}] ${result.status} ${canonicalPath}${entry.lastError ? " :: " + entry.lastError : ""}`);
      }
      store(canonicalPath, entry);
      return entry;
    })();

    pending.set(canonicalPath, run);
    try {
      return await run;
    } finally {
      pending.delete(canonicalPath);
    }
  }

  // ---- 通道一：工作区域新增记录 ----

  function onDomainChanged(change) {
    // 三个字段全中才处理：本插件自己的落盘不经过 storage 域，但该过滤仍是防止
    // 其他域写入（以及未来变化）引发误触发与递归的唯一依据。
    if (change === null || typeof change !== "object") return;
    if (change.domain !== DOMAIN_NAME || change.table !== TABLE_NAME) return;
    if (change.operation !== "put") {
      if (change.operation === "deleted") {
        logger.info(`skipped:workspace-unregistered ${typeof change.key === "string" ? change.key : ""}`);
      }
      return;
    }
    const value = change.value;
    if (value === null || typeof value !== "object" || typeof value.path !== "string") {
      logger.warn("skipped:malformed workspace record on domain/changed");
      return;
    }
    // 事件回调只做判重与入队，阻塞 I/O 交给异步链。
    void ensureAcl(value.path, "workspace-event").catch((error) => {
      logger.warn(`workspace-event handler failed: ${String(error)}`);
    });
  }

  if (readConfig().watchWorkspaces) {
    ctx.on("domain/changed", onDomainChanged);
  }

  // ---- 加载时补漏：覆盖插件加载之前已注册的工作区（同属通道一语义） ----

  async function sweepRegistered() {
    try {
      const registry = ctx.get("workspaceRegistry");
      if (registry === undefined || registry === null || typeof registry.list !== "function") return;
      const list = registry.list();
      if (!Array.isArray(list)) return;
      for (const workspace of list) {
        if (typeof workspace?.path !== "string") continue;
        await ensureAcl(workspace.path, "sweep");
      }
    } catch (error) {
      logger.warn(`sweep failed: ${String(error)}`);
    }
  }

  // ---- 设置页接口 ----

  function snapshotConfig() {
    const { watchWorkspaces, deepGrant, retryCooldownMs } = readConfig();
    return { watchWorkspaces, deepGrant, retryCooldownMs };
  }

  function snapshotWhitelist() {
    return Object.keys(records)
      .map((canonicalPath) => ({ path: canonicalPath, ...records[canonicalPath] }))
      .sort((left, right) => (right.at ?? 0) - (left.at ?? 0));
  }

  // 新增走短路：已授权目录只登记不重跑 icacls。要强制重跑由「重新授权」按钮触发。
  async function addPath(target) {
    return ensureAcl(target, "settings-add", false);
  }

  function removePath(target) {
    if (typeof target !== "string" || target.trim().length === 0) return false;
    const canonicalPath = canonicalize(resolve(target.trim()));
    const key = canonicalPath ?? resolve(target.trim());
    hot.delete(key);
    // 只移除本插件的记录，绝不动目录上已存在的任何 ACE。
    if (key in records) {
      delete records[key];
      persist();
      logger.info(`whitelist entry removed (no ACE revoked) ${key}`);
      return true;
    }
    return false;
  }

  /** 变更类响应回带的目标路径；界面靠它把结果讲清楚。 */
  function targetOf(body) {
    const value = body?.path;
    return typeof value === "string" ? value.trim() : "";
  }

  function sendJson(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }

  function readJsonBody(request) {
    return new Promise((resolveBody, rejectBody) => {
      const chunks = [];
      let size = 0;
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          rejectBody(new Error("request body too large"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        if (text.length === 0) { resolveBody({}); return; }
        try { resolveBody(JSON.parse(text)); } catch (error) { rejectBody(error); }
      });
      request.on("error", rejectBody);
    });
  }

  function trusted(request, response) {
    if (isTrustedRequest(request, ctx.webRuntime?.trustedHosts ?? [])) return true;
    logger.warn(`rejected untrusted request: ${String(request?.url ?? "")}`);
    sendJson(response, 403, { ok: false, error: "forbidden" });
    return false;
  }

  async function handleState(request, response) {
    if (!trusted(request, response)) return;
    try {
      sendJson(response, 200, {
        ok: true,
        platform: process.platform,
        supported: IS_WINDOWS,
        stateFile: stateFilePath(),
        config: snapshotConfig(),
        whitelist: snapshotWhitelist(),
      });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: String(error) });
    }
  }

  function makeMutation(handler) {
    return async (request, response) => {
      if (!trusted(request, response)) return;
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" });
        response.end();
        return;
      }
      try {
        const body = await readJsonBody(request);
        const result = await handler(body);
        sendJson(response, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: String(error) });
      }
    };
  }

  // 路由注册：依赖已由静态 inject 保证就绪，直接取 ctx.webServer 并由 ctx.effect
  // 持有注销器；单条路由注册失败只记日志，不带垮整个插件。
  // 变更类路由一律回带目标路径：客户端要据它把结果讲清楚（命中跳过态时不会入库，
  // 单看列表会以为什么都没发生）。
  const routes = [
    { kind: "exact", path: `${ROUTE_PREFIX}/state`, handler: handleState },
    {
      kind: "exact",
      path: `${ROUTE_PREFIX}/add`,
      handler: makeMutation(async (body) => ({ path: targetOf(body), entry: await addPath(body?.path) })),
    },
    {
      kind: "exact",
      path: `${ROUTE_PREFIX}/regrant`,
      handler: makeMutation(async (body) => ({
        path: targetOf(body),
        entry: await ensureAcl(body?.path, "settings-regrant", true),
      })),
    },
    {
      kind: "exact",
      path: `${ROUTE_PREFIX}/remove`,
      handler: makeMutation(async (body) => ({ path: targetOf(body), removed: removePath(body?.path) })),
    },
  ];

  ctx.effect(() => {
    const disposers = [];
    for (const route of routes) {
      try {
        disposers.push(ctx.webServer.register(route));
      } catch (error) {
        logger.warn(`route ${route.path} was not registered: ${String(error)}`);
      }
    }
    logger.info(`${ROUTE_PREFIX} routes registered (${disposers.length}/${routes.length})`);
    return () => { for (const dispose of disposers) dispose(); };
  }, "workspace-acl-allow: routes");

  logger.info(`ready (state: ${stateFilePath()})`);
  void sweepRegistered();
}
