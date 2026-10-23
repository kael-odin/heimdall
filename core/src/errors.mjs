/**
 * errors — 把技术错误翻成"人话 + 下一步"
 *
 * 控制台和其它前端此前都在直接渲染 `String(e.message)` 或后端的英文 `error` 码，
 * 用户看到的是一行堆栈或 `fetch failed`，不知道下一步该干什么。
 * 这里只做一件事：**识别已知的失败类别**，给一句中文说明 + 一个可执行动作，
 * 同时把原始信息原样保留在 `detail` 里（界面可以放进"详情"折叠，日志里仍然完整）。
 *
 * 纯函数、无 IO、无依赖 —— 引擎、CLI、控制台都能直接 import。
 */

/** @typedef {{ title: string, hint: string, detail: string, kind: string }} HumanError */

const RULES = [
  {
    kind: 'engine-down',
    test: (m) => /fetch failed|ECONNREFUSED|ECONNRESET|ERR_CONNECTION|socket hang up|Failed to fetch|NetworkError/i.test(m),
    title: '连不上引擎',
    hint: '引擎可能没在运行，或者端口不对。先确认它起来了：`curl http://127.0.0.1:8900/api/status`；然后刷新页面重试。',
  },
  {
    kind: 'auth',
    test: (m) => /\b401\b|unauthorized|token/i.test(m),
    title: '引擎要求口令（Token）',
    hint: '这个引擎开启了鉴权。在右上角「设置 → 引擎 Token」里填入与 HEIMDALL_TOKEN 相同的值，保存后刷新。',
  },
  {
    kind: 'busy',
    test: (m) => /\b409\b|busy|already running|正在运行/i.test(m),
    title: '同类任务已经在跑',
    hint: '同一时间只能有一个克隆/审计/验收任务。等它结束，或先点「停止」再来。',
  },
  {
    kind: 'timeout',
    test: (m) => /timeout|timed out|ETIMEDOUT|deadline|超时/i.test(m),
    title: '操作超时',
    hint: '站点可能很慢或卡在了某个资源上。先确认那个地址在浏览器里能正常打开；必要时减小页数上限再试。',
  },
  {
    kind: 'not-found',
    test: (m) => /\b404\b|not found|ENOENT|no such file/i.test(m),
    title: '目标不存在',
    hint: '要打开的文件或记录已经不在了：可能被清理过，或者 URL 输错了。回到列表刷新一次看看还剩什么。',
  },
  {
    kind: 'disk',
    test: (m) => /ENOSPC|no space left|磁盘|space/i.test(m),
    title: '磁盘空间不足',
    hint: '产物目录写满了。打开「存储」卡片看占用，先回收孤儿资源或清空回收站，再重试。',
  },
  {
    kind: 'permission',
    test: (m) => /EACCES|EPERM|permission denied|拒绝访问/i.test(m),
    title: '没有写入权限',
    hint: '产物目录被占用或被系统保护了。确认没有别的程序打开着它；Windows 上尤其注意不要放在受保护目录里。',
  },
  {
    kind: 'invalid-input',
    test: (m) => /invalid|bad host|bad url|400\b|格式|不合法/i.test(m),
    title: '输入不合法',
    hint: '地址要写成完整的 http(s)://host/路径；域名里不能带空格或中文标点。改一下再提交。',
  },
  {
    kind: 'browser',
    test: (m) => /Executable doesn't exist|browserType\.launch|chromium|playwright/i.test(m),
    title: '缺少浏览器内核',
    hint: '采集需要 Chromium。跑一次 `pnpm -C core exec playwright install chromium` 就好。',
  },
  {
    kind: 'catalog-migration',
    test: (m) => /MIGRATION_REQUIRED|schemaVersion|CATALOG_MIGRATION/i.test(m),
    title: '验收目录版本需要升级',
    hint: '这是旧版本的验收目录。先停掉同根目录下的其它引擎，再运行 `core/src/acceptance/catalog-maintenance-cli.mjs --create --target-schema 4` 完成迁移。',
  },
];

/**
 * @param {unknown} error  Error / 字符串 / 后端返回的 {error, code}
 * @param {{ fallback?: string }} [opts]
 * @returns {HumanError}
 */
export function explainError(error, { fallback } = {}) {
  const detail = extractDetail(error);
  const codes = extractCodes(error);
  const haystack = `${codes.join(' ')} ${detail}`.trim();
  const rule = RULES.find(r => r.test(haystack));
  if (rule) return { kind: rule.kind, title: rule.title, hint: rule.hint, detail };
  return {
    kind: 'unknown',
    title: '操作没有成功',
    hint: fallback ?? '展开下面的详情看看具体原因；如果反复出现，把详情贴进 issue。',
    detail,
  };
}

function extractDetail(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const parts = [];
    if (error.code) parts.push(String(error.code));
    if (error.status) parts.push(`HTTP ${error.status}`);
    if (error.error) parts.push(String(error.error));
    if (error.message && error.message !== error.error) parts.push(String(error.message));
    return parts.filter(Boolean).join(' · ') || String(error);
  }
  return String(error);
}

function extractCodes(error) {
  const out = [];
  if (error && typeof error === 'object') {
    for (const key of ['code', 'status', 'statusCode']) if (error[key] != null) out.push(String(error[key]));
    // 后端有时把状态码塞在 message 里（"HTTP 404"），上面的 detail 已经包含，这里只为排序稳定
  }
  return out;
}
