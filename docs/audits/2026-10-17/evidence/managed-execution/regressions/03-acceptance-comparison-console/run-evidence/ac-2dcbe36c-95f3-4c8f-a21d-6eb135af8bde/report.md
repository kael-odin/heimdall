# 判据变化：扩大响应预算 · 项目验收报告

任务：ac-2dcbe36c-95f3-4c8f-a21d-6eb135af8bde
模式：spec；时间：2026-10-16T22:08:31.602Z → 2026-10-16T22:08:31.690Z
需求来源：comparison-api-fixture；版本：v1
清单批准：已显式声明批准
来源指纹：d933b590092feb2046181d907e32ecb76cbe5545ca833598b862725150738955
契约指纹：ce379431a3cc3a487e6c395bbeda3e5bd0efda0952c9eae018e0de4e14bef624
目标：http://127.0.0.1:51852/

计划指纹：79b14650b453f700456d3224f2be6ca5955ebacab3590528ab6b57599b971e3e
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
| spec-1-QUOTA | /quota | api | passed | match | high |
| spec-2-STABLE | /stable | api | failed | bug | high |

## 问题与证据

### spec-2-STABLE · 稳定接口保持通过

结论：bug；证据等级：http-reproduced；参照：{"kind":"approved-spec","source":"comparison-api-fixture","revision":"v1","sourceFingerprint":"d933b590092feb2046181d907e32ecb76cbe5545ca833598b862725150738955","documentSha256":null,"contractFingerprint":"ce379431a3cc3a487e6c395bbeda3e5bd0efda0952c9eae018e0de4e14bef624"}
预期：{"status":200,"contentType":"application/json","json":[{"pointer":"/code","kind":"equals","value":0}]}
实际：{"requested":true,"httpStatus":200,"contentType":"application/json","redirectNotFollowed":false,"hasLocation":false,"mismatches":[{"kind":"equals","pointer":"/code","value":0,"passed":false,"actual":1,"exists":true}],"bytes":22,"bodySha256":"df61ffdcb5955ed36c07c80da21c929098fafe6796d027b174e7d8b394af13ce","assertions":[{"pointer":"/code","kind":"equals","value":0,"passed":false,"actual":1,"exists":true}]}

复现步骤：

1. Use requirement comparison-api-fixture at revision v1.
2. GET http://127.0.0.1:51852/stable without cookies or credentials; redirects are not followed.
3. Compare HTTP status, declared MIME and explicit JSON assertions/schema.

证据文件：

- contract：spec-2-STABLE-contract.json
- request：spec-2-STABLE-request.json
- response：spec-2-STABLE-response.json

## 边界

仅执行用户批准清单的 GET/HEAD，不跟随重定向、不携带会话或凭据。明确断言与支持的响应 schema 是本次真值；来源指纹用于追溯，不证明需求本身正确。未覆盖操作、未批准候选、网络/执行/响应/验证预算受阻不能通过。响应 JSON 保存在本地鉴权证据中；没有视觉、认证、数据库、写操作或完整业务状态机验收保证。
