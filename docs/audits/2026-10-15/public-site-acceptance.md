# 公开页面独立交付验收（2026-10-15）

本轮只访问公开、无需登录的页面，数据写在系统临时目录；未修改仓库现有 `core/workspace/` 或 `core/deliverable/`。所有结论只针对本次声明的页面范围，不能推广为任意站点或完整业务复刻。

## 结果

| 站点与范围 | 发现 | 克隆 | v2 三视口验证 | 严格离线导出 | 搬迁后运行 |
| --- | ---: | ---: | ---: | --- | --- |
| `example.org` 首页 | 1/1 | 1/1 | 1/1，三个视口均 100% | 通过，全部严格阻断项为 0 | 通过；阻断浏览器外联后仍可加载，未知路径返回 404 |
| `vite.dev/guide/` 的受限侦察样本 | 3/3 | 3/3 | 3/3，平均 90.94% | 失败；未发布正式包 | 未验收，因为没有合格交付包 |
| `vite.dev/` 扩大范围阶段 | 57 个同源 URL，含根页 | 57/57 | 57/57，平均 91.51%；6 A / 51 B | 失败；`root=mirror` 候选保留，未发布正式包 | 未验收，因为没有合格交付包 |
| `hobix.com/learn/examples/A01/` 的三页样本 | 3/3 | 3/3 | 3/3，九个视口均 100% | `--root landing` 通过，全部严格阻断项为 0 | 通过；搬迁后阻断外联，三页导航与主图正常 |

`example.org` 包移出源工作区后独立启动：根路径和 `/lm/example.org/` 均返回 200；Playwright 阻断非本地请求后，本地请求全部返回 200、站外请求 0、页面脚本错误 0。`health.coverage` 的分母、克隆、有效 v2 验证、交付均为 1，浏览器探测 1/1、HTTP 探测 3/3。没有声明操作流程，因此仅能判定公开首页可离线浏览。

`vite.dev` 使用 `maxPages=3`、`maxDepth=1`。sitemap 有 57 个同源 URL，侦察页数和深度预算均受限；其余页面没有进入本次分母。三页全部入队并完成三视口验证，最差是 `/acknowledgements` 手机视口 68.93%。首次严格导出报告 21 处未解析资源、115 处跨源资产引用、75 个未镜像链接，浏览器断网探针因前置缺口没有运行。加入 `--heal --materialize-har` 后，跨源资产引用降至 28，但未解析资源增至 64、未镜像链接增至 81，仍未通过。修复 HAR 落盘后的二级资源补抓顺序并重跑后，同站资源 322/322 可本地提供，未解析数降至 0；其余 28 处跨源引用与 81 个未镜像链接仍阻断严格导出。之后修复站外导航误改写，并按精确 URL、MIME 与体积预算补抓 4 个公开文本端点，该阶段候选包仍有 28 处跨源资源引用和 67 个未镜像链接；由于缺少域名根页，`--root mirror` 另有 1 个根页阻断，浏览器断网探针 3 页未运行。没有操作计划，不能判定公开交互可用。

最初剩余 28 处跨源引用归并后为 9 个 URL：GitHub 赞助者头像引用 4 次、Carbon Ads 脚本 3 次、广告或转化像素 21 次。旧候选包的 81 个未镜像链接还包含四个公开文本端点及被误改写的站外广告点击地址；这些误改写和文本端点已处理。此前候选包的 67 个未镜像链接主要仍是三页预算之外的站内页面，另有缺失的站点根路径 `/`。这些是本次范围和资源策略的真实缺口，不能用放宽门禁视为通过。

后续以当前代码对三页隔离样本显式执行 `--offline --strict --root landing --heal --materialize-har --rebuild --omit-nonvisual-pixels`，候选包仍未发布。重新构建复用已捕获的头像与 GIF；这次导出选择省略跨源、`display:none` 的 1×1 图片像素，`health.nonvisualExternalPixels={policy:"omit",files:6,removed:24}`（live 与 static 各三页）。默认导出会保留这些节点；省略可能影响读取 DOM 的脚本，不能据此证明行为等价。隔离对照显示，六份 HTML 除这些隐藏标签外逐字节相同，可见广告图的 SHA-256 未变。最新候选的同站缺资源为 **0**、跨源静态资产 **3**、未镜像链接 **67**；剩余 3 处均为 CarbonAds 脚本。该脚本还会请求动态广告 JSON，不能仅因已捕获脚本文件就算离线可用。浏览器严格探针因前置阻断项仍有 3 页未测；`root=landing` 的根页计数为 0 不表示 `root=mirror` 已具备真实根页。诊断保存在 `%TEMP%/heimdall-public-vite-e0296a6d/deliverable/.candidate-vite.dev-QpmEKQ/health.json`。

`hobix.com` 样本从 `/learn/examples/A01/` 侦察，设置 `maxPages=3`、`maxDepth=2`；首页及无尾斜杠的 `/walk`、`/about` 共三页被发现并克隆。页数预算已触顶，不能声称整个域名或子目录全集已发现。最终代码重新运行 v2 验证后，三页在 375、768、1440 宽度共九个视口均完整测量为 100%，留存的截图可见正文与 `/walk` 的路线图。严格导出采用 `--offline --strict --root landing --heal --materialize-har --rebuild`：资源 4/4 本地可提供，链接 14/14 可到本地页，跨源资产 0，包内阻断外联的首次加载探针 3/3，通过项的全部严格阻断计数为 0。最终输出目录在 `%TEMP%/heimdall-public-a01-priority-20261015/deliverable/a01-offline-final-20261015`。该站域名根页未捕获，`/` 是 Heimdall 落地页；三页镜像入口为 `/lm/hobix.com/learn/examples/A01/`。

最终包另复制到 `%TEMP%/heimdall-a01-final-relocated-6c4ffbbf634c4c018406b5ce2dcc5d23`，从复制目录运行包内 `serve.mjs`，以 `--offline --root landing --host 127.0.0.1 --port 18932` 启动。Playwright 阻断非该回环服务的请求和 WebSocket 后，两次加载 `/` 均返回落地页 200；落地页已声明内联图标，浏览器不再请求缺失的 `/favicon.ico`。随后实际点击首页 → walk → about → 首页，路径和标题正确；walk 主图从包内 `/static/hobix.com/pages/walk/clone/assets/image000.svg` 加载成功。全程记录 11 次请求，外联、HTTP 4xx/5xx、请求失败、console 错误、pageerror、WebSocket 均为 0。前一版包还验证了正文链接首页 → walk → 首页及未知镜像路径返回预期 404；最终包在此后只改动落地页图标声明。未配置操作计划，所以自动严格门禁只证明首载；额外的浏览器验收仅覆盖上述简单导航，本站没有登录、写入或后台业务测试。验收浏览器已关闭，`18932` 预览服务保留供查看。

严格浏览器探针升级后，A01 三页另导出到 `%TEMP%/heimdall-public-a01-priority-20261015/deliverable/a01-observe-20261015`。`health.json` 显示 3/3 页完成阻断外联首载、0 失败、0 未测；每页至少观察 3000 毫秒、500 毫秒网络安静期、默认最长 8000 毫秒，三页实测约 3040 至 3056 毫秒，全部严格阻断项为 0。新探针用受控夹具验证了 2 秒后才触发的 404 与悬挂请求会阻断发布。此处没有新增登录或点击流程验收；超过观察窗口才发起的请求仍可能未被探测。

该新版包又被复制到 `%TEMP%/heimdall-a01-observe-relocated-1225acdec3964b2f97a87b58cfb872fc`，不依赖原工作区，使用包内 `serve.mjs --port 18933 --offline --root landing --host 127.0.0.1` 启动。Playwright 在首次导航前阻断非本地 HTTP 与全部 WebSocket，实际点击首页 → Canal walk → About → Home；四次路径分别为 `/lm/hobix.com/learn/examples/A01/`、`/walk`、`/about`、首页，标题正确。随后继续观察 3.2 秒，外联、本地 HTTP 4xx/5xx、请求失败、页面异常、console 错误与 WebSocket 均为 0。验收浏览器和 `18933` 服务已关闭。此项是浏览器断外联加包内离线服务器验证，并非该包的 Docker 无网络隔离验收。

## 运行口径

三个样本分别使用隔离的 `HEIMDALL_DATA_DIR`。`example.org` 使用 `--root mirror`；A01 因未捕获域名根页使用 `--root landing`，不能把它写成根路径替代部署。Vite 三页先试 `--root mirror`，后为隔离广告与缺页问题试 `--root landing`，两种模式都未通过。Vite 的队列使用 `--all-discovered`，隔离引擎端口为 18900，验证进程相应设置 `HEIMDALL_PORT=18900`。失败的导出保留 `.candidate-*` 诊断目录，未生成正式包。

Vite 首次侦察还暴露了并发页数超限：`maxPages=3` 实际写出 5 个节点。已修复调度，让在途访问占用预算；重跑后实际为 3 个节点，新增并发反例测试。该修复只保证本次侦察不超出声明页数，不会自动发现 sitemap 或链接图中的所有页面。

扩大范围阶段使用另一个隔离数据目录，从 `https://vite.dev/` 运行 `recon`（`maxPages=60`、`maxDepth=1`），25.8 秒得到 57 个同源 URL，访问失败 0，深度边界外仍有 1 个 URL；其中 51 个来自 sitemap，不能称整站全发现。`queue --all-discovered` 后续续跑完成：57/57 页均有克隆、评分和情报，0 队列失败。2026-10-15 15:35 的 v2 三视口汇总为 57/57 完整测量、0 未测、平均 91.51%，6 页 A、51 页 B；最差页是 `/acknowledgements` 的 375×812，68.93%。53 页含 CarbonAds 注入的 4 个隐藏 1×1 坏图；验证器已区分全部坏图与可见坏图，仅可见坏图阻断视觉测量，离线外联仍由严格导出单独阻断。

随后对同一工作区执行 `--offline --strict --root mirror --heal --materialize-har --omit-nonvisual-pixels --rebuild`。57 个已发现页面全部有克隆和包内路由，`mirrorRootMissing=0`；HAR/自愈后同源资源 6108/6109 本地，剩余 1 个未解析项是 `/live/` 页的 YouTube `youtube-nocookie.com` 嵌入。候选包另有 54 处跨源静态资产引用，归并后是同一个 `https://cdn.carbonads.com/carbon.js`；23 个未镜像链接归并后为 20 个唯一路径，其中 12 个是 `.md` 源文档链接，8 个是 `/rolldown`、`/why`、`/api-plugin` 等路径。严格浏览器探针因前置阻断项 57 页未测。候选包约 190.7 MB，路径为 `%TEMP%/heimdall-public-vite-wide-c40b0b28/deliverable/.candidate-vite.dev-x9QQW3`；旧正式包保持不变，未发布新正式包。CarbonAds 是第三方运行时广告服务，不能靠下载脚本宣称业务等价或离线可用。

后续侦察实现新增有界的客户端渲染链接观察与 SPA 改址直访标记，已用受控站点测试。之后在新的隔离目录按同一预算（`maxPages=60`、`maxDepth=1`）重跑 Vite 侦察：57/57 URL 与旧 atlas 完全一致，边数同样为 7，访问失败 0；57 页均完成渲染链接观察，0 页触顶，0 个客户端路由未验证，深度边界外仍剩 1 个 URL。该站在本预算下没有发现旧实现漏掉的页面，不能把 57 个 URL 视为整站全集。

本地门禁：本轮 `pnpm test` 共 854 项（852 通过、0 失败、2 项 Docker 用例按环境跳过），`pnpm lint`、`pnpm smoke`、`pnpm build`、`pnpm docs:links` 均通过。本机 Docker 守护进程未启动。主分支提交 `ea1005a` 的 Linux CI 已通过；其中的 Docker `--network none` 步骤覆盖 SSR/SPA/数据驱动 SPA 与适配器卷持久化。受控夹具、A01 简单页面和 Vite 57 页视觉验证都不改变严格离线导出失败的结论。

## 下一步

1. 补齐或明确排除 Vite 的 23 个未镜像链接，重点解释 12 个 `.md` 源文档链接与 8 个路径别名；再用更高深度或页面预算验证 57 URL 是否仍是当前站点结构的合理分母。
2. 对 CarbonAds 与 YouTube 嵌入给出显式“不支持/需站点所有者授权替代”报告；对可安全本地化的跨源静态资源继续使用精确批准补抓，并逐项验证断网行为。
3. 为菜单、搜索、分页等公开交互编写操作计划；对有状态业务使用逐站适配器，并在无外联容器中验证实际包、包外持久卷及重启。继续扩展认证、iframe、Shadow DOM、长页和延迟请求样本，逐类报告通过、未测和失败。
