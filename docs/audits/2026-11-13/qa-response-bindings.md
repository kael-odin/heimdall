# 动态资源响应关联实测

2026-11-13。创建接口返回随机 ID 时，固定路径或常量断言无法核对后续读取、更新是否使用同一资源。本轮在既有 QA 被动观察器中增加较早响应字段引用，贯通 CLI、HTTP 与 MCP；不增加网络动作、依赖、运行模块或测试文件，冻结验收器及 SEO 评分 12 / 测量 8 / GEO 7 保持原样，仍为 64 条 SEO 规则。

## 行为与范围

- `pathParams` 将 `response` 编号与 JSON 字段路径绑定至完整路径段；`equalsFrom` 用较早响应的标量作为 JSON 预期。编号从 0 开始，只能引用当前检查点的较早声明；每项 JSON 断言恰好选择 `equals` 或 `equalsFrom`，兼容原常量与对象/数组写法。
- 源响应必须唯一、符合自身声明，且 CDP 完成时间不晚于目标请求开始时间。观察候选请求不等待异步读取正文，最终按声明顺序核对，避免快速后续请求丢失；上游证据失效时下游引用不可通过。
- 仅保留声明需要的标量投影于观察器内存，关闭时清除。被引用源字段也接受现有 256 KiB、未压缩、JSON 类型及可核实大小限制，正文最多读取一次。输出保留模板与引用元数据，不输出绑定值或正文；截图和其他既有网络证据仍可能包含业务数据。
- 相同方法、来源、查询条件下的重叠路径声明被拒绝；重复请求保留 `ambiguous`，不按次数选取。`path-mismatch` 表示请求资源串号，`reference-unavailable` 表示来源、字段或时间无法核实；仍为 `qa_incomplete` / 退出码 3，不自动认定产品缺陷。
- 不构造请求、不填 UI、不绑定凭据、不跨检查点保存；原写策略继续决定请求能否实际发出。格式与限制见[测试工作区](../../TEST-WORKSPACE.md#核对页面自然发出的接口响应)。

设计参考本机 REA 的 `docs/specs/agent-environments/scenario-saved-values/plan.md` 中“保存响应的类型值供后续使用”的思路。读取的是设计计划，不能据此声称 REA 已实现全部能力；本轮只实现被动比对所需的有限引用。

## 真实后端与故障对照

复用仓库外固定版本 `json-server@1.0.0-beta.15` 及既有锁文件，启动新建的可丢弃数据库。受控页面点击后依次 POST 创建、GET 返回的动态 ID、PATCH 同一 ID。PATCH 路径引用 POST，响应 ID 引用 GET，验证传递关系。页面在各场景都显示 Ready，错误由响应关联发现。

| 场景 | CI / 退出码 | POST → GET → PATCH | 到达网关的业务请求 |
|---|---|---|---:|
| 健康 | passed / 0 | matched → matched → matched | 3 |
| 读取另一资源 | incomplete / 3 | matched → path-mismatch → reference-unavailable | 3 |
| 读取应答 ID 错误 | incomplete / 3 | matched → json-mismatch → reference-unavailable | 3 |
| 更新应答 ID 类型错误 | incomplete / 3 | matched → matched → json-mismatch | 3 |
| 重复读取 | incomplete / 3 | matched → ambiguous → reference-unavailable | 4 |
| 默认阻断写入 | incomplete / 3 | request-failed → missing → missing | 0 |
| 只声明创建，读取应答 ID 错误 | passed / 0 | 只核对 POST，覆盖有限 | 3 |
| 恢复 | passed / 0 | matched → matched → matched | 3 |

八场景符合预期；七次实际创建产生七个不同 ID，仅在汇总保留哈希。CLI 输出及各次 QA JSON/Markdown 报告均未出现生成 ID 或私有字段标记。每次获准流程只有页面自身的三条业务请求，重复场景四条；计数不含 HTML、favicon 或参考服务就绪探测。

这些是一个真实开源后端的机制实测与自有网关注入故障，不是八个独立项目，也不是 JSON Server 公共漏洞。只声明创建的对照说明未声明的读取行为仍会漏检，不代表完整后端通过。未进行网站克隆、生产认证/权限、事务、并发或完整业务等价验收。

## 回归与交付证据

在已有两个测试文件内覆盖声明校验、延迟正文读取、时间证据、上游失败、重复请求、类型及路径编码。补查 null、布尔值、零、中文与斜杠 ID、超长值、点路径、缺失时间、重复完成事件与正文未读完时的失败；这些是受控回归分支，不累计成独立真实案例。首次 MCP 集成暴露工具说明超过 1,200 字符，已压缩说明后通过，未放宽注册上限。

完整运行证据与参考依赖留在 `D:/Github-Star/heimdall-evidence-archive/2026-11-13/qa-response-bindings/`。`acceptance.json` 记录八场景、请求数、参考版本/锁哈希、源码哈希及隐私标记检查；`pilot.mjs` 是外部验收驱动，`pilot.log` 保留 CLI 终态，`runs/` 保留逐场景原始记录。仓库只增加本篇摘要，其他改动复用原文件。

本地响应/QA CI 回归 **17/17**，HTTP 策略/注册表/规则口径 **15/15**，MCP 全套 **7/7** 通过，无跳过；各集合不互相累计为真实案例。语法 765 文件、文档 779 个目标 / 157 个文件、冻结验收 14 文件，以及插件新鲜度、技能同步和 diff 检查通过。日志为 `related-tests-final.log`、`policy-schema-tests.log`、`mcp-suite.log`、`syntax.log`。

## 最终 Hosted 验收

源码提交 [`22b85a1a`](https://github.com/kael-odin/heimdall/commit/22b85a1a817e2691a0acb38d781570f94ffd5208) 的 [CI 43388727172](https://github.com/kael-odin/heimdall/actions/runs/43388727172) **8/8 job 成功**，同提交 [Docs 43388727069](https://github.com/kael-odin/heimdall/actions/runs/43388727069) 成功。

Hosted Node 22 两片完整 Core 共 3,332 条，**3,328 通过、0 失败、4 条件跳过**。其中两条 Docker 用例在服务 job 另行 **2/2 通过**，其余两条为 Linux 不适用的 Windows 文件句柄用例。MCP 干净安装及全套测试 **7/7** 通过，包含动态关联的实际代理调用。语法 765 文件、文档链接、冻结验收 14 文件、完整浏览器链、QA Action、构建与依赖审计均成功。本地、Hosted 与案例验证不累计为独立样本数，Hosted 测试不代表又做八个真实项目。

`ci-source-completed.json`、`docs-source-completed.json` 记录精确提交和终态；八份 `ci-*.log` 保存逐 job 原始日志，`ci-test-totals.json` 保留 TAP 汇总及跳过项。`acceptance-summary.json` 汇总本地回归、真实后端场景、报告复核、源码与参考哈希。验收进程已经退出，参考依赖及生成数据库未进入仓库。
