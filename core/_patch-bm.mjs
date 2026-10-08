import { readFileSync, writeFileSync } from 'node:fs';
const f = 'D:/Github-Star/heimdall/core/src/browser/bookmarklet.mjs';
let c = readFileSync(f, 'utf8');
const start = c.indexOf('export function buildBookmarklet');
const end = c.indexOf('export function renderInstallPage');
if (start < 0 || end < 0) { console.error('anchors missing'); process.exit(1); }
const body = `export function buildBookmarklet(mode = 'recon', { api = 'http://127.0.0.1:8900', token = '' } = {}) {
  const def = MODES[mode] ?? MODES.recon;
  const url = api.replace(/\\/$/, '') + def.path + (token ? '?token=' + encodeURIComponent(token) : '');
  // location.href 以占位符注入，避免在 Node 侧求值
  const bodyExpr = JSON.stringify(def.body('__HM_URL__')).replace('"__HM_URL__"', 'location.href');
  const js = '(async()=>{try{await fetch(' + JSON.stringify(url) + ',{method:\\'POST\\',mode:\\'no-cors\\',headers:{\\'Content-Type\\':\\'text/plain\\'},body:JSON.stringify(' + bodyExpr + ')});alert(' + JSON.stringify(def.label + '：已提交 ') + ' + location.host + \\'（在 Heimdall 控制台「任务」查看）\\');}catch(e){alert(\\'Heimdall 连接失败：\\' + e.message);}})();';
  return 'javascript:' + encodeURIComponent(js);
}

`;
c = c.slice(0, start) + body + c.slice(end);
writeFileSync(f, c);
console.log('bookmarklet body fix ok');
