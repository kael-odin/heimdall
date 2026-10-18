# API Spec 固定注入基准

运行：spec-benchmark-2026-10-18T03-34-54-939Z-947b0fca
生成时间：2026-10-18T03:34:56.122Z

**离线复现：固定 API 缺陷注入与执行策略反例，只证明这组已声明合同和观察窗口，不代表真实项目检出率或完整 OpenAPI 兼容性。**

基准门禁：通过；案例校验 11/11；执行策略守卫 4/4。

## 计算口径

统计单位是独立 API 案例，每个案例一条固定合同；已知 BUG 7，非 BUG 4，总案例 11。草稿、遗漏与只读拒绝守卫单独检查，不加入检出率分母。

TP/FN 由已知 BUG 是否产出 bug 分类决定；FP/TN 由非 BUG 是否被误报决定。环境阻塞保持非通过；不能因超时或预算不足免除真实 BUG 漏检。重定向不跟随，但已观察到 302 与约定 200 不同，构成确定 HTTP 合同缺陷。

| 指标 | 数值 |
| --- | ---: |
| TP / FP / FN / TN | 7 / 0 / 0 / 4 |
| Precision | 100.00% |
| Recall | 100.00% |
| False positive rate | 0.00% |
| 耗时 | 1183 ms |

## 案例

| 案例 | 真值 | 检出 | 门禁 | 校验 | 问题 |
| --- | --- | --- | --- | --- | --- |
| healthy | match | 无 BUG | passed | 通过 |  |
| wrong-code | BUG | BUG | failed | 通过 |  |
| missing-field | BUG | BUG | failed | 通过 |  |
| wrong-type | BUG | BUG | failed | 通过 |  |
| wrong-status | BUG | BUG | failed | 通过 |  |
| non-json | BUG | BUG | failed | 通过 |  |
| bad-json | BUG | BUG | failed | 通过 |  |
| redirect | BUG | BUG | failed | 通过 |  |
| oversized | environment | 无 BUG | blocked | 通过 |  |
| slow | environment | 无 BUG | blocked | 通过 |  |
| head | match | 无 BUG | passed | 通过 |  |

## 执行策略守卫

- preview-no-requests：通过；OpenAPI 转候选不访问 servers；候选保留完整来源且保持未批准；本地请求 0。
- draft-no-requests：通过；未批准的全部 11 个候选只生成阻塞证据；HTTP 请求 0。
- omission-no-requests：通过；明确漏项生成阻塞门禁，不能被空检查或批准标记变成通过。
- write-method-rejected：通过；将候选篡改为 POST 时，在请求之前拒绝。

## 证据

- [healthy 报告](healthy/report.md)：同目录包含原始 OpenAPI 来源、合同、HTTP 请求摘要、响应/错误证据与指纹；文档指纹独立重算核对。
- [wrong-code 报告](wrong-code/report.md)：同目录包含原始 OpenAPI 来源、合同、HTTP 请求摘要、响应/错误证据与指纹；文档指纹独立重算核对。
- [missing-field 报告](missing-field/report.md)：同目录包含原始 OpenAPI 来源、合同、HTTP 请求摘要、响应/错误证据与指纹；文档指纹独立重算核对。
- [wrong-type 报告](wrong-type/report.md)：同目录包含原始 OpenAPI 来源、合同、HTTP 请求摘要、响应/错误证据与指纹；文档指纹独立重算核对。
- [wrong-status 报告](wrong-status/report.md)：同目录包含原始 OpenAPI 来源、合同、HTTP 请求摘要、响应/错误证据与指纹；文档指纹独立重算核对。
- [non-json 报告](non-json/report.md)：同目录包含原始 OpenAPI 来源、合同、HTTP 请求摘要、响应/错误证据与指纹；文档指纹独立重算核对。
- [bad-json 报告](bad-json/report.md)：同目录包含原始 OpenAPI 来源、合同、HTTP 请求摘要、响应/错误证据与指纹；文档指纹独立重算核对。
- [redirect 报告](redirect/report.md)：同目录包含原始 OpenAPI 来源、合同、HTTP 请求摘要、响应/错误证据与指纹；文档指纹独立重算核对。
- [oversized 报告](oversized/report.md)：同目录包含原始 OpenAPI 来源、合同、HTTP 请求摘要、响应/错误证据与指纹；文档指纹独立重算核对。
- [slow 报告](slow/report.md)：同目录包含原始 OpenAPI 来源、合同、HTTP 请求摘要、响应/错误证据与指纹；文档指纹独立重算核对。
- [head 报告](head/report.md)：同目录包含原始 OpenAPI 来源、合同、HTTP 请求摘要、响应/错误证据与指纹；文档指纹独立重算核对。

基准只访问本机临时夹具。运行结束后服务器关闭，历史端口不可继续访问；JSON/Markdown 和合同证据供离线核查。真实认证、写入、数据库状态、视觉和未支持的 OpenAPI 语义均未验收。
