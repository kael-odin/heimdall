# 公开 API 后端独立部署与缺陷复测

日期：2026-11-12。用 DummyJSON 公开测试接口的实际响应验证 B1 契约、B2 回放、B3 服务和缺陷复验，不把响应回放当成原站后端实现。

## 真实样本与修复

样本为 `GET /products/category/beauty`，实际访问返回 HTTP 200，包含 5 条商品记录。正文经过既有隐私清洗，仅在仓库外用于生成观察型契约和回放模块。所有缺陷注入都在本地副本中执行，没有对源站发起写操作。

真实数据暴露了脚手架的两个校验错误：

- 契约投影复用了名称归一化，把 `discountPercentage` 等必填 JSON 字段转成小写，导致健康响应被误报；中文、空格和空字段名还会被删除。现在保留 JSON 字段的原始身份。
- 数值检查的条件先排除了 `number`，导致字符串、布尔、对象和数组绕过数值类型检查。现在按实际 JSON 类型比较，并保留整数也符合 `number` 的语义。

只修改共享脚手架生成器，在已有测试文件中增加一个参数化回归；没有新增依赖、检测器、产品命令或测试文件。

## 实际运行结果

| 场景 | 结果 | 解释 |
| --- | --- | --- |
| 修改前生成器 + 健康响应 | failed | 错误地认为驼峰必填字段缺失 |
| 当前生成器 + 同一健康响应 | passed | 必填字段和数值检查正常 |
| 删除首条商品的 discountPercentage | failed | 正确检出必填字段缺失，生成响应契约修复任务 |
| 把首条商品 price 改成字符串 | failed | 定位到 `$.products[0].price`，预期 number、实际 string |
| 恢复原响应后复验 | passed | 修复任务归零 |

旧生成器来自修改前的真实 Git 版本，同一批数据分别生成两个独立目录。不是手工编写一个近似旧实现进行对照。

随后临时移开原数据目录，直接启动独立目录中的 Node 服务并执行其 `checks.mjs`：检查通过，原数据目录在运行期间确实不存在，完成后恢复。没有安装 npm 依赖，也没有读取源工作区才能启动的运行组件。

将独立包放回默认工作区前，核对服务、检查器、契约及适配器两个文件的 SHA-256 全部一致。`site-assessment` 返回 `api.scaffold.check.status: passed`，而 `readiness.backend.status` 仍为 `needs_human_review`，没有把有限响应检查升级成业务等价结论。

## 验证与证据

- `node --test core/test/agent-backend-scaffold.test.mjs core/test/agent-assessment.test.mjs`：9/9 通过。
- 新回归同时覆盖原始字段名、健康数值、整数、四种非数值类型、逐个删除必填字段以及修复后再次通过。
- `pnpm -C core test:fast`：1,330/1,330 通过；语法检查覆盖 763 个文件，文档链接检查覆盖 147 份文档的 744 个目标。

外部证据目录：`D:/Github-Star/heimdall-evidence-archive/2026-11-12/backend-public-api/`。

| 证据 | 内容 |
| --- | --- |
| capture-summary.json | 实际请求、采集时间、HTTP 状态和样本数量 |
| summary.json | 旧版、健康、两种注入缺陷和修复后的比较 |
| missing-required-field.json / wrong-number-type.json | 缺陷检查报告与修复任务 |
| standalone-proof.json | 原工作区缺席时检查通过及五个文件的 SHA-256 |
| registered-assessment.json | 对独立包检查结果的 AI 站点评估 |
| deployment/previous 与 deployment/current | 分别由旧版和当前生成器产生的可启动包 |

## 未完成范围

本次只观察一个接口的一次有效响应。留出验证为 `not-validated`，不能据此判断泛化；5 条商品记录也不是 5 次独立观察。没有验证认证、权限、状态转换、持久化、写入、异常业务规则、真实副作用或完整 JSON Schema。

本轮使用本机 Node 执行独立包，没有重跑 Docker 部署或控制台完整演示。新增修复只作用于新生成的脚手架；已有包须在新 `--out` 目录生成后迁移定制实现并重新验证，不应直接覆盖已经补写的业务代码。
