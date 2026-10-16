# 托管 Spec · 明确待验收版本 · 项目验收报告

任务：ac-0dd6e7c1-0fa3-4912-8e63-95ce825ab04a
模式：spec；时间：2026-10-16T22:05:08.114Z → 2026-10-16T22:05:13.245Z
需求来源：REQ-MANAGED-EXECUTION；版本：1
清单批准：已显式声明批准
来源指纹：bb4de9250608bd5d6b1515e0d95d086b34bf62a17da01cbf0a72fb2ed09a308e
契约指纹：73fb6ba9970764becca68eb2602eb6dbdbfdea8d9c758ecc2b3663e5bcec10d4
目标：http://127.0.0.1:62733/target?tenant=execution

计划指纹：0bbff5bb75c419e15a9b5fbec242cbb650221622f1d0ffbaa220099942360277
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
| spec-1-CHECK-0 | /healthy | api | passed | match | medium |
| spec-2-CHECK-1 | /bug | api | failed | bug | high |

## 问题与证据

### spec-2-CHECK-1 · 业务码必须为零

结论：bug；证据等级：http-reproduced；参照：{"kind":"approved-spec","source":"REQ-MANAGED-EXECUTION","revision":"1","sourceFingerprint":"bb4de9250608bd5d6b1515e0d95d086b34bf62a17da01cbf0a72fb2ed09a308e","documentSha256":null,"contractFingerprint":"73fb6ba9970764becca68eb2602eb6dbdbfdea8d9c758ecc2b3663e5bcec10d4"}
预期：{"status":200,"contentType":"application/json","json":[{"pointer":"/code","kind":"equals","value":0}]}
实际：{"requested":true,"httpStatus":200,"contentType":"application/json","redirectNotFollowed":false,"hasLocation":false,"mismatches":[{"kind":"equals","pointer":"/code","value":0,"passed":false,"actual":9,"exists":true}],"bytes":10,"bodySha256":"006bc09a1498874b1e271f6c8cf4cb88ceb7c2b5b6e42f684a3dd5157bb15c45","assertions":[{"pointer":"/code","kind":"equals","value":0,"passed":false,"actual":9,"exists":true}]}

复现步骤：

1. Use requirement REQ-MANAGED-EXECUTION at revision 1.
2. GET http://127.0.0.1:62733/target/bug without cookies or credentials; redirects are not followed.
3. Compare HTTP status, declared MIME and explicit JSON assertions/schema.

证据文件：

- contract：spec-2-CHECK-1-contract.json
- request：spec-2-CHECK-1-request.json
- response：spec-2-CHECK-1-response.json

## 边界

仅执行用户批准清单的 GET/HEAD，不跟随重定向、不携带会话或凭据。明确断言与支持的响应 schema 是本次真值；来源指纹用于追溯，不证明需求本身正确。未覆盖操作、未批准候选、网络/执行/响应/验证预算受阻不能通过。响应 JSON 保存在本地鉴权证据中；没有视觉、认证、数据库、写操作或完整业务状态机验收保证。
