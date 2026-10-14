# 04 · 旧产物维护

这两条命令只服务已有 `core/workspace/<siteId>/pages/` 产物，不参与正常 `forge`、`queue`、`verify` 主链路。它们按文件症状判断是否适用：旧产物没有统一的构建版本字段，不能仅靠目录日期断言版本。所有命令默认先预览；不要在未核对站点 ID、页数和备份位置时批量执行。

## 缺失的原站全页截图

旧页若缺少 `shot-src-full.png`，可先列出可补拍页面：

```powershell
Set-Location core
node src/crawler/fullshot.mjs example.com
node src/crawler/fullshot.mjs example.com home
```

确认后加 `--apply` 才会启动 Chromium。脚本只处理有有效 `manifest.json`、目标 origin 与站点身份一致且截图确实缺失的页面；跨 origin 跳转会失败，已存在的图不会被覆盖。坏 manifest 和来源不符的页面会列为 skipped。

```powershell
node src/crawler/fullshot.mjs example.com home --apply
```

**时间边界**：这是在运行命令的时刻重新访问原站，不是历史捕获时刻的画面。原站可能已经改版，因此新图只适合补齐浏览对照入口；不能把它与旧 DOM/旧克隆拼成“同时间点”的保真度证据。需要可信评分时重新捕获整页并跑当前 v2 验证。`fullshot` 不改旧评分文件。

## 旧 CSS 相对路径坏链

旧版 `clone/styles/cssom.css` 曾把 `styles/refNNN.woff2` 之类的路径当作从 clone 根目录解析，浏览器实际从 `styles/` 子目录解析，导致 `styles/styles/...` 404。当前 `build_clone.mjs` 已正确生成相对路径；此工具只修复仍符合旧症状的 CSS 引用。

```powershell
Set-Location core
node src/cli.mjs repair example.com
```

默认只打印 `would-fix`，不写文件。确认后：

```powershell
node src/cli.mjs repair example.com --apply
```

写盘前，原 CSS 自动备份到 `HEIMDALL_DATA_DIR/_maintenance/repair-css-refs-<时间>/`（未设置数据目录时在 `core/_maintenance/`）。可用 `--backup-dir <目录>` 指定备份位置；不能放在 `workspace/` 内。备份沿用 `pages/<page>/clone/styles/<file>` 相对路径，按同路径复制回去即可恢复。修复保留 query/hash，重复运行应显示 `fixes=0`。

该脚本只扫描普通站点目录下的普通 CSS 文件，跳过符号链接目录和符号链接 CSS。它不会替你验证浏览器中的字体与资源是否正常；应用后需要打开克隆页检查相关 CSS 资源，必要时重新运行离线资源检查。

`core/src/clone-doc.mjs` 不属于旧产物修复工具。它是当前引擎、评分和导出共用的多视口文档选择逻辑，须继续与新构建产物同步维护。
