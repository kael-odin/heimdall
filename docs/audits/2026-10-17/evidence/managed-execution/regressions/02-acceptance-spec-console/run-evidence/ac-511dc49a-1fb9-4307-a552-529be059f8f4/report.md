# 手工需求契约验收 · 项目验收报告

任务：ac-511dc49a-1fb9-4307-a552-529be059f8f4
模式：spec；时间：2026-10-16T22:08:18.428Z → 2026-10-16T22:08:18.491Z
需求来源：manual-api-requirements；版本：v2
清单批准：已显式声明批准
来源指纹：4062230c92de1c99194e163c7526c6e9178eb3a074fd9c19ee3532f9cd345dff
契约指纹：4e89f62b6e31c8602c919188300fcd05a35bf88b731ba4bb9b3a3d4f6b75f2d2
目标：http://127.0.0.1:59656/

计划指纹：219e712e636683c7faa18734a51b15707faa69907039086b0f9783763195b796
验证器指纹：e4214464d2fa64ee97ee957ec0777f329195251d7596a3fed0366bb188d5ece8

**门禁：阻断：发现缺陷**

声明检查 2，已形成结果 2，完成可靠判定 2。
通过 1；失败 1；阻塞 0；待复核 0；目标缺陷 1；基线失败 0；缺测 0。

仅验收明确批准的 GET/HEAD 及声明的 HTTP、MIME、JSON 字段/响应 schema；不使用会话、不跟随重定向。候选、未覆盖契约、超时、超响应/验证预算均不能通过；无视觉、数据库、写操作、认证或任意业务状态机保证。来源指纹用于追溯，不代表系统已经证明原需求正确。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 0 | 0 | 0 | 0 | 0 | 未测 |
| structure | 0 | 0 | 0 | 0 | 0 | 未测 |
| behavior | 2 | 1 | 1 | 0 | 0 | 未测 |
| health | 0 | 0 | 0 | 0 | 0 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| spec-1-MANUAL-1 | /healthy | api | passed | match | high |
| spec-2-MANUAL-2 | /missing-field | api | failed | bug | high |

## 问题与证据

### spec-2-MANUAL-2 · 响应包含需求规定的名称

结论：bug；证据等级：http-reproduced；参照：{"kind":"approved-spec","source":"manual-api-requirements","revision":"v2","sourceFingerprint":"4062230c92de1c99194e163c7526c6e9178eb3a074fd9c19ee3532f9cd345dff","documentSha256":null,"contractFingerprint":"4e89f62b6e31c8602c919188300fcd05a35bf88b731ba4bb9b3a3d4f6b75f2d2"}
预期：{"status":200,"contentType":"application/json","json":[{"pointer":"/code","kind":"equals","value":0},{"pointer":"/data/name","kind":"required"},{"pointer":"/data/id","kind":"type","type":"integer"},{"pointer":"/data/active","kind":"enum","values":[true]}],"schema":{"type":"object","required":["code","data"],"additionalProperties":false,"properties":{"code":{"type":"integer","const":0},"data":{"type":"object","required":["id","name","active"],"additionalProperties":false,"properties":{"id":{"type":"integer"},"name":{"type":"string"},"active":{"type":"boolean"}}}}}}
实际：{"requested":true,"httpStatus":200,"contentType":"application/json","redirectNotFollowed":false,"hasLocation":false,"mismatches":[{"kind":"required","pointer":"/data/name","passed":false,"actual":"[missing]","exists":false},{"kind":"json-schema","pointer":"/data/name","keyword":"required","expected":"name","actual":{"type":"object","properties":1,"sha256":"7dc386e22fccb03994ed06cb561164205272a488be8d121895fb86de2c654f39","detail":"See authenticated response evidence."}}],"bytes":40,"bodySha256":"951cbb026c1daed8fba867deeacf06e02f4a7209fa77d1a4e098b1e6fdd5ecb5","assertions":[{"pointer":"/code","kind":"equals","value":0,"passed":true,"actual":0,"exists":true},{"pointer":"/data/name","kind":"required","passed":false,"actual":"[missing]","exists":false},{"pointer":"/data/id","kind":"type","type":"integer","passed":true,"actual":7,"exists":true},{"pointer":"/data/active","kind":"enum","values":[true],"passed":true,"actual":true,"exists":true}],"schemaFailures":[{"pointer":"/data/name","keyword":"required","expected":"name","actual":{"type":"object","properties":1,"sha256":"7dc386e22fccb03994ed06cb561164205272a488be8d121895fb86de2c654f39","detail":"See authenticated response evidence."}}]}

复现步骤：

1. Use requirement manual-api-requirements at revision v2.
2. GET http://127.0.0.1:59656/missing-field without cookies or credentials; redirects are not followed.
3. Compare HTTP status, declared MIME and explicit JSON assertions/schema.

证据文件：

- contract：spec-2-MANUAL-2-contract.json
- request：spec-2-MANUAL-2-request.json
- response：spec-2-MANUAL-2-response.json

## 边界

仅执行用户批准清单的 GET/HEAD，不跟随重定向、不携带会话或凭据。明确断言与支持的响应 schema 是本次真值；来源指纹用于追溯，不证明需求本身正确。未覆盖操作、未批准候选、网络/执行/响应/验证预算受阻不能通过。响应 JSON 保存在本地鉴权证据中；没有视觉、认证、数据库、写操作或完整业务状态机验收保证。
