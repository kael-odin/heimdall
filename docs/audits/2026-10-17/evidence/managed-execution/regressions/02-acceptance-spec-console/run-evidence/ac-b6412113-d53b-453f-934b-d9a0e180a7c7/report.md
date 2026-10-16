# OpenAPI 候选契约验收 · 项目验收报告

任务：ac-b6412113-d53b-453f-934b-d9a0e180a7c7
模式：spec；时间：2026-10-16T22:08:20.788Z → 2026-10-16T22:08:20.863Z
需求来源：openapi-b1c25a66855ed0c6；版本：2026-10-16
清单批准：已显式声明批准
来源指纹：dbc99652b2c88cafdedc1152ab4825180e084e68e6284531b8801ec5dec2759d
契约指纹：9ef03f5d782aac788313fd27eaa99094ef4540fdcb290a7beaa72496cf8951c9
目标：http://127.0.0.1:59656/

计划指纹：c6c117b81bea699d96e93f6cba3dd33e89669f9b16a16e1ada3656ac1e082860
验证器指纹：e4214464d2fa64ee97ee957ec0777f329195251d7596a3fed0366bb188d5ece8

**门禁：阻断：发现缺陷**

声明检查 3，已形成结果 3，完成可靠判定 2。
通过 1；失败 1；阻塞 1；待复核 0；目标缺陷 1；基线失败 0；缺测 0。

仅验收明确批准的 GET/HEAD 及声明的 HTTP、MIME、JSON 字段/响应 schema；不使用会话、不跟随重定向。候选、未覆盖契约、超时、超响应/验证预算均不能通过；无视觉、数据库、写操作、认证或任意业务状态机保证。来源指纹用于追溯，不代表系统已经证明原需求正确。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 0 | 0 | 0 | 0 | 0 | 未测 |
| structure | 0 | 0 | 0 | 0 | 0 | 未测 |
| behavior | 2 | 1 | 1 | 0 | 0 | 未测 |
| health | 1 | 0 | 0 | 1 | 0 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| spec-1-openapi-1 | /healthy | api | passed | match | high |
| spec-2-openapi-3 | /wrong-code | api | failed | bug | high |
| spec-omission-1 | /write | api | blocked | needs_review | medium |

## 问题与证据

### spec-2-openapi-3 · /wrong-code 契约

结论：bug；证据等级：http-reproduced；参照：{"kind":"approved-spec","source":"openapi-b1c25a66855ed0c6","revision":"2026-10-16","sourceFingerprint":"dbc99652b2c88cafdedc1152ab4825180e084e68e6284531b8801ec5dec2759d","documentSha256":"b1c25a66855ed0c662d3656d0899ff332f38d5b9cc9c424d11271cd97f0b7577","contractFingerprint":"9ef03f5d782aac788313fd27eaa99094ef4540fdcb290a7beaa72496cf8951c9"}
预期：{"status":200,"contentType":"application/json","schema":{"additionalProperties":false,"properties":{"code":{"const":0,"type":"integer"},"data":{"additionalProperties":false,"properties":{"active":{"type":"boolean"},"id":{"type":"integer"},"name":{"type":"string"}},"required":["id","name","active"],"type":"object"}},"required":["code","data"],"type":"object"}}
实际：{"requested":true,"httpStatus":200,"contentType":"application/json","redirectNotFollowed":false,"hasLocation":false,"mismatches":[{"kind":"json-schema","pointer":"/code","keyword":"const","expected":0,"actual":400}],"bytes":60,"bodySha256":"7ca34ed7c95ff4d47ae1874064b09e62b775c007c5590b0979654a04fdea2351","assertions":[],"schemaFailures":[{"pointer":"/code","keyword":"const","expected":0,"actual":400}]}

复现步骤：

1. Use requirement openapi-b1c25a66855ed0c6 at revision 2026-10-16.
2. GET http://127.0.0.1:59656/wrong-code without cookies or credentials; redirects are not followed.
3. Compare HTTP status, declared MIME and explicit JSON assertions/schema.

证据文件：

- source：requirement-source.json
- contract：spec-2-openapi-3-contract.json
- request：spec-2-openapi-3-request.json
- response：spec-2-openapi-3-response.json

### spec-omission-1 · 未覆盖契约：POST /write

结论：needs_review；证据等级：source-confirmed；参照：{"kind":"approved-spec","source":"openapi-b1c25a66855ed0c6","revision":"2026-10-16","sourceFingerprint":"dbc99652b2c88cafdedc1152ab4825180e084e68e6284531b8801ec5dec2759d","documentSha256":"b1c25a66855ed0c662d3656d0899ff332f38d5b9cc9c424d11271cd97f0b7577","contractFingerprint":"9ef03f5d782aac788313fd27eaa99094ef4540fdcb290a7beaa72496cf8951c9"}
预期：Every declared operation has an executable, approved contract.
实际：{"requested":false,"reason":"only GET and HEAD are read-only candidates; this method is not executed"}

复现步骤：

1. Resolve the declared unsupported requirement before approving a full API scope.

证据文件：

- source：requirement-source.json
- contract：spec-omission-1.json

## 边界

仅执行用户批准清单的 GET/HEAD，不跟随重定向、不携带会话或凭据。明确断言与支持的响应 schema 是本次真值；来源指纹用于追溯，不证明需求本身正确。未覆盖操作、未批准候选、网络/执行/响应/验证预算受阻不能通过。响应 JSON 保存在本地鉴权证据中；没有视觉、认证、数据库、写操作或完整业务状态机验收保证。
