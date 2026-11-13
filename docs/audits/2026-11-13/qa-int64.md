# 64 位整数资源关联实测

2026-11-13。修正被动响应核对提前把 JSON 长整数转为 JavaScript Number，造成错误通过与健康流程误拒绝的问题。复用原观察器、声明校验、两个测试文件和技能文档，没有新增依赖、运行模块或测试文件；冻结验收器及 SEO 评分 13 / 测量 8 / GEO 8 不变。

## 机制与改动

[RFC 8259 第 6 节](https://www.rfc-editor.org/rfc/rfc8259#section-6)说明 JSON 数值与实现精度的互操作边界；JSON 长整数本身并非非法。真实后端可以返回精确整数，但普通 JSON.parse 可能先将相邻 ID 舍入为同一个 Number，使后续路径和字段比较失真。

- 在原有的一次 JSON 解析中使用原始数值 token，把超出安全范围的普通整数在内存保留为 BigInt；`pathParams` 和 `equalsFrom` 直接使用精确值。它仍代表 JSON 数字，与同内容的字符串区分，不向输出或 JSON-RPC 写入 BigInt。
- 字符串和整数引用文本仍最多 200 字符；原 token 最多 200 位数字。超限、非有限值，以及超出安全范围整数的小数点或指数写法保留未核实。有限小数沿用 Number 比较，不提供任意精度小数核验。
- `equals` 整数常量超出安全范围时拒绝声明，因为配置进入 JavaScript 后已无法恢复原值；安全整数、有限小数及其他标量保持原行为。MCP 字段说明与工作区、CI、技能文档同步。
- 读取仍受原有 256 KiB、MIME、压缩、时间及唯一响应限制；不新增请求，不增加写入权限，关闭观察器时清除投影值。

## 真实后端对照

仓库外安装固定版本 [Datasette 0.65.2](https://docs.datasette.io/en/0.65.2/json_api.html)，读取一份自有 SQLite 数据库。[SQLite 整数存储](https://www.sqlite.org/datatype3.html)支持 64 位有符号范围。数据库含相邻长整数主键、普通主键和最大正整数；网关转发参考服务的原 JSON 文本，没有重新序列化数值。

自有页面先读取选中行，再读取该主键。健康页面按原 token 构造地址；缺陷页面使用普通 JSON.parse 舍入 ID，或由自有网关返回相邻行。所有场景页面均显示 Ready；独立页面断言没有失败，差异由接口声明核对发现。这是一个真实服务的八场景机制试验，不是八个独立项目，也不是 Datasette 产品漏洞。

| 场景 | 修改前第二响应 | 修改后第二响应 | 修改后 CLI |
| --- | --- | --- | --- |
| 普通整数健康 | matched | matched | 0 |
| 长整数精确路径 | path-mismatch | matched | 0 |
| 前端舍入后读错资源 | matched | path-mismatch | 3 |
| 固定路径返回相邻行 | matched | json-mismatch | 3 |
| 固定路径返回正确行 | matched | matched | 0 |
| SQLite 最大正整数精确路径 | path-mismatch | matched | 0 |
| 数字被返回成字符串 | json-mismatch | json-mismatch | 3 |
| 恢复精确读取 | path-mismatch | matched | 0 |

修正两次错误通过和三次健康流程误拒绝。前后每个场景均只有页面自身的两次业务 GET，不含 HTML、favicon 和服务就绪探测；核对器没有额外发请求，原读取策略不变；响应不符继续为 `qa_incomplete`，不自动认定产品缺陷或提单。CLI 与四类 QA 报告均未出现绑定 ID 或私有字段标记。

## 回归与证据

扩展原响应测试中的字符串、数字、类型、延迟读取和隐私对照，覆盖精确长整数、正负边界、相邻值、字符串类型、200/201 位、非有限值及未支持写法。修改前长整数健康测试失败，修改后通过。原 MCP 代理测试同时运行字符串 ID 和长整数 ID，验证跨进程 JSON 返回不会泄漏内部值。

本地响应、QA CI、HTTP 策略和注册表相关回归 **20/20**，MCP **7/7** 通过，无跳过；追加数字上限分支后的观察器测试通过。语法 765 文件、技能同步、插件新鲜度、文档链接与冻结验收 14 文件检查通过。断网只读 Node 22.23.5 容器确认了原 token 读取能力；完整模块仍以托管 Node 22 回归为准。

证据位于 `D:/Github-Star/heimdall-evidence-archive/2026-11-13/qa-int64/`，包含固定参考依赖清单、数据库、原始参考响应、`before.json`、`after.json`、逐场景 QA 报告、`acceptance-summary.json` 和测试日志。初次验收驱动误读 CI 摘要中不存在的 results 字段而退出，该次目录和日志保留；后测通过可见项断言计数单独验证页面，前测原始发现中没有独立页面断言失败。

未验证生产认证、事务、并发、完整业务正确性或任意精度小数。本轮不改变克隆、后端补写或 SEO/GEO 行为。

## 托管验收

源码 `114ce06287fba255e10551afceea9840907713e4` 的 [CI 43434478454](https://github.com/kael-odin/heimdall/actions/runs/43434478454) **8/8 作业成功**，同提交 [Docs 43434478307](https://github.com/kael-odin/heimdall/actions/runs/43434478307) 成功。托管 Node 22 完整 Core **3,332 通过 / 0 失败 / 4 条件跳过**，共 3,336 条；两条 Docker 用例在独立断网作业 **2/2** 通过，另两条为 Linux 不适用的 Windows 句柄用例。干净安装 MCP **7/7**，包含字符串及长整数的真实代理调用。完整浏览器链与已知真值检测基准、构建、依赖审计均通过。

`ci-source-completed.json`、`docs-source-completed.json` 保存精确提交与终态，`ci-test-totals.json` 从原始 TAP 提取计数及跳过项，`ci-*.log` 保留相关原始日志。本地、托管与八场景验证不累计为独立项目数。参考服务和验收进程均已退出，参考环境与数据库未进入仓库。
