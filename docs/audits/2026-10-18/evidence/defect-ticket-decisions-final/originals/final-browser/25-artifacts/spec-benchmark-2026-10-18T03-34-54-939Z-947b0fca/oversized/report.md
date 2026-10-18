# Heimdall 固定 API 验收夹具 API 验收候选 · 项目验收报告

任务：spec-benchmark-2026-10-18T03-34-54-939Z-947b0fca-oversized
模式：spec；时间：2026-10-18T03:34:55.081Z → 2026-10-18T03:34:55.097Z
需求来源：openapi-e82e1bddfc3906e1；版本：1.0.0
清单批准：已显式声明批准
来源指纹：5a920f4da30f08ce48fc3f02f72165ac1edb859121f1146cf788a4103941e554
契约指纹：9178d3d4cc97ec4fbf5b35da5b2d479fcbfa31e280e52299fea85194d46fd8ed
目标：http://127.0.0.1:52293/

**门禁：阻断：存在未测/环境失败**

声明检查 1，已形成结果 1，完成可靠判定 0。
通过 0；失败 0；阻塞 1；待复核 0；目标缺陷 0；基线失败 0；缺测 0。

离线复现：固定 API 缺陷注入与执行策略反例，只证明这组已声明合同和观察窗口，不代表真实项目检出率或完整 OpenAPI 兼容性。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 0 | 0 | 0 | 0 | 0 | 未测 |
| structure | 0 | 0 | 0 | 0 | 0 | 未测 |
| behavior | 1 | 0 | 0 | 1 | 0 | 未测 |
| health | 0 | 0 | 0 | 0 | 0 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| spec-1-openapi-6 | /oversized | api | blocked | environment | high |

## 问题与证据

### spec-1-openapi-6 · 固定合同 oversized

结论：environment；证据等级：offline-reproduced；参照：{"kind":"approved-spec","source":"openapi-e82e1bddfc3906e1","revision":"1.0.0","sourceFingerprint":"5a920f4da30f08ce48fc3f02f72165ac1edb859121f1146cf788a4103941e554","documentSha256":"e82e1bddfc3906e15573aab2144c4f811d7560b6a1c61609f8e9eeeeb57564a8","contractFingerprint":"9178d3d4cc97ec4fbf5b35da5b2d479fcbfa31e280e52299fea85194d46fd8ed"}
预期：{"status":200,"contentType":"application/json","schema":{"additionalProperties":false,"properties":{"code":{"const":0,"type":"integer"},"data":{"additionalProperties":false,"properties":{"active":{"type":"boolean"},"id":{"type":"integer"},"name":{"type":"string"}},"required":["id","name","active"],"type":"object"}},"required":["code","data"],"type":"object"}}
实际：{"requested":true,"httpStatus":200,"contentType":"application/json","redirectNotFollowed":false,"hasLocation":false,"mismatches":[],"error":"Response exceeds 16384 byte body budget","errorCode":"RESPONSE_BODY_BUDGET","evaluationLimited":true}

复现步骤：

1. Use requirement openapi-e82e1bddfc3906e1 at revision 1.0.0.
2. GET http://127.0.0.1:52293/oversized without cookies or credentials; redirects are not followed.
3. Compare HTTP status, declared MIME and explicit JSON assertions/schema.

证据文件：

- source：requirement-source.json
- contract：spec-1-openapi-6-contract.json
- request：spec-1-openapi-6-request.json
- response：spec-1-openapi-6-response.json

## 边界

仅执行用户批准清单的 GET/HEAD，不跟随重定向、不携带会话或凭据。明确断言与支持的响应 schema 是本次真值；来源指纹用于追溯，不证明需求本身正确。未覆盖操作、未批准候选、网络/执行/响应/验证预算受阻不能通过。响应 JSON 保存在本地鉴权证据中；没有视觉、认证、数据库、写操作或完整业务状态机验收保证。
