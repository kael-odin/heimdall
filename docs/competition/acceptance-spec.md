# Spec：需求清单与只读 API 契约验收

更新：2026-10-16。控制台“项目验收”已增加 **Spec**，直接用明确需求检查目标项目，无需运行基线或浏览器截图。[Mirror / Regression 指南](acceptance-workbench.md)和[赛题规划](02-自动验收开发项目还原度BUG检测系统.md)仍分别说明页面对照与长期方向。

## 使用流程

1. 选择 Spec，填写目标 API 入口 URL、来源 ID、版本与接口契约；或粘贴 OpenAPI **JSON 3.0 / 3.1** 后点击生成候选。
2. 逐条核对预期、来源、候选数量及未覆盖项。生成候选不会访问文档中的服务器，也不会请求目标接口。
3. 明确勾选批准当前清单后执行。目标、来源、文档、检查或未覆盖项变化会撤销批准。CLI 中由 `spec.approved: true` 声明当前清单已经批准；这不是带身份签名的组织审批系统。
4. 查看接口契约与运行健康结果、来源文档、请求、响应和契约 JSON，下载报告。只有门禁 `passed` 才能放行。

API 路径沿用入口相对规则：入口 `https://test.example/api` 与 `/quota` 组合为 `/api/quota`；`/` 保持入口本身。请明确填写实际入口，避免重复 `/api`。不接受跨域路径、路径穿越、凭据 URL 或任意脚本。

## 本地比赛演示

先在一个终端启动仅监听回环地址的夹具：

```powershell
node core/test/fixtures/acceptance-api.mjs 9088
```

另一个终端运行已批准的固定演示清单：

```powershell
node core/src/acceptance/cli.mjs --plan config/acceptance/spec-demo.json --gate
```

该清单有健康接口、HTTP 200 但 `code=400`、缺少名称三个案例，预期门禁失败、退出码 1。也可把 [OpenAPI 示例](../../config/acceptance/spec-openapi.json)粘贴进控制台，目标填写 `http://127.0.0.1:9088`；导入后仍需明确批准。无参启动夹具只显示用法，不启动服务器，避免 Node 测试自动发现时挂起。

独立固定真值基准与控制台闭环：

```powershell
pnpm acceptance:spec:benchmark
pnpm -C console build
pnpm acceptance:spec:smoke
```

基准有 11 个独立案例，7 个确定内容或 HTTP 缺陷、2 个健康案例、2 个环境受阻案例。另行验证候选零请求、遗漏阻断、写方法拒绝和重定向不跟随。固定夹具没有代表性抽样，不能推广为真实项目检出率。

## 手工契约格式

```json
{
  "schemaVersion": 1,
  "name": "配额业务验收",
  "mode": "spec",
  "targetUrl": "http://127.0.0.1:9088",
  "spec": {
    "source": { "id": "REQ-QUOTA", "revision": "v1", "type": "manual" },
    "approved": true,
    "checks": [{
      "id": "QUOTA", "title": "查询配额业务成功", "method": "GET", "path": "/healthy",
      "expect": {
        "status": 200, "contentType": "application/json",
        "json": [
          { "pointer": "/code", "kind": "equals", "value": 0 },
          { "pointer": "/data/name", "kind": "required" },
          { "pointer": "/data/id", "kind": "type", "type": "integer" },
          { "pointer": "/data/active", "kind": "enum", "values": [true, false] }
        ]
      }
    }]
  }
}
```

`status` 必填，按精确整数比较；`contentType` 按 MIME 比较，忽略响应参数和大小写。JSON Pointer 使用 RFC 6901：空字符串代表整个响应，`~1` 表示 `/`，`~0` 表示 `~`，数组索引不接受 `01`。`equals` 不做类型转换，`0`、`false`、空字符串和 `null` 不会被当作缺失。

也支持 `expect.schema` 响应 schema：boolean schema、type / union / null、properties / required / additionalProperties、items 与数组数量、enum / const、数值和字符串长度边界、allOf / anyOf / oneOf / not。正则、format、未实现关键词和外部引用明确拒绝；不隐式删除字段、补默认值或转换类型。完整可执行子集及预算在 `core/src/acceptance/response-schema.mjs`。

HEAD 只检查声明的 HTTP / MIME，不接受正文断言。每个接口契约生成一个结果；任意明确谓词失败即证明该契约失败。后续验证受预算限制时，已确认的缺陷仍保留，同时记录 `evaluationLimited`；没有确定缺陷的超时、超大响应或验证预算耗尽为环境受阻。

## OpenAPI 候选和未覆盖项

`POST /api/acceptance/openapi/preview` 接收 `{document, targetUrl, name}`，返回未批准的 `plan`、`coverage` 与 `warnings`。复用引擎 Token 鉴权。覆盖字段为 `declaredOperations / candidateChecks / omittedOperations / complete / ratio`。

当前支持固定路径、GET / HEAD、一个明确成功状态、一个 JSON 响应 MIME、本地 `#/components/` 引用、显式且符合 schema 的简单查询样例。3.0 nullable 和独占数值边界转换为执行器支持的语义，3.1 boolean schema 保留。文档 `servers` 不参与选址，唯一请求入口是用户填写的 `targetUrl`。

写方法、认证、缺少显式样例的查询参数（包括可选参数）、参数化路径、复杂序列化、多义成功响应、响应头契约、远程 / 循环引用、自定义 dialect、writeOnly 响应语义、webhooks 或不支持的 schema 都明确记入 `omissions`。每个已识别操作恰好进入候选或遗漏；不能仅凭可执行子集通过就宣布整份文档通过。只有遗漏的文档也能生成受阻报告。

候选带完整 `spec.document` JSON 快照与 `source.sha256`。创建任务时重新校验文档哈希；改变原文但保留旧哈希会被拒绝。执行时保存 `requirement-source.json`，报告可独立重算文档指纹并追溯当前派生契约。文档 SHA-256 按排序对象键后的完整 JSON 计算，独立于原文件缩进和键顺序；证据清单另记录包装证据文件的字节哈希，两者不是同一口径。人工增强契约不会改写原文，另由计划 / 契约指纹追踪。

## 预算、证据和边界

- 最多 32 个接口契约、64 个未覆盖操作，每个契约最多 20 个字段断言；超限拒绝，不静默抽样。
- 每请求默认 10 秒，允许 1–30 秒；每次运行最多 5 分钟。响应默认 256 KiB，允许 1 KiB–1 MiB；按实际流式字节限制，分块响应同样受控。
- 原文最多 4 MiB、深度 64、100,000 JSON 节点；预览请求体允许文档外加 16 KiB 包装，验收计划请求体最多 7 MiB。响应 schema 和实例还有独立深度、节点、分支与计算预算。
- 只发送 GET / HEAD，不使用 Cookie、Token 或现有浏览器会话，不跟随重定向。观察到的 302 可以直接与声明状态比较；不会请求重定向目的地。
- 完整有界响应 JSON 只写入本地鉴权证据。报告中的字符串、对象与数组实际值使用类型 / 长度 / 哈希摘要；数字、布尔与 null 保留。AI 沿用原有显式、脱敏摘要链路，不上传完整响应或来源文档。

门禁、历史、取消、重启恢复和证据下载沿用现有验收 API。Spec 没有视觉分、数据库真值、登录态、写操作或任意业务状态机保证；没有声明的业务字段保持未测。OpenAPI 是输入依据，不代表实现或文档本身天然正确。PRD 自动拆解、Figma、认证适配、缺陷生命周期和修复闭环仍是后续工作。

规范参考：OpenAPI 3.0 / 3.1 与 RFC 6901；本实现主动拒绝未实现的约束，不宣称实现完整规范。

本阶段的完整回归、受控基准、真实控制台与模型解读证据见 [Spec 实施验收记录](../audits/2026-10-16/acceptance-spec.md)。
