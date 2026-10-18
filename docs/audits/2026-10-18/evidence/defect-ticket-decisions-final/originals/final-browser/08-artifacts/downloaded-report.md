# 托管 Spec · 待验收版本 · 项目验收报告

任务：ac-3c2710fa-a1e7-4075-b4a4-941c1e88cc13
模式：spec；时间：2026-10-18T03:08:34.581Z → 2026-10-18T03:08:34.603Z
需求来源：MANAGED-READ；版本：1
清单批准：已显式声明批准
来源指纹：49b4fa20a5a9b567b571afc993bec476652bc7e75b3ac59131f4e5542e658a4a
契约指纹：d25e213ee788ec8d4a1ebef8d1067d9ca85024589228c2160fb9cc396d94ab90
目标：http://127.0.0.1:49328/target

计划指纹：d4ac2f40f243bd9929c572187be98a33fe4b78bb054eea9f94703691d4499848
验证器指纹：2e59d9d52a22a146e32c0cf3db32c4644c8e977d40ef927d365d4def4644b337

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
| spec-1-READ-0 | /healthy | api | passed | match | high |
| spec-2-READ-1 | /bug | api | failed | bug | high |

## 问题与证据

### spec-2-READ-1 · 业务码符合需求

结论：bug；证据等级：http-reproduced；参照：{"kind":"approved-spec","source":"MANAGED-READ","revision":"1","sourceFingerprint":"49b4fa20a5a9b567b571afc993bec476652bc7e75b3ac59131f4e5542e658a4a","documentSha256":null,"contractFingerprint":"d25e213ee788ec8d4a1ebef8d1067d9ca85024589228c2160fb9cc396d94ab90"}
预期：{"status":200,"contentType":"application/json","json":[{"pointer":"/code","kind":"equals","value":0}]}
实际：{"requested":true,"httpStatus":200,"contentType":"application/json","redirectNotFollowed":false,"hasLocation":false,"mismatches":[{"kind":"equals","pointer":"/code","value":0,"passed":false,"actual":9,"exists":true}],"bytes":10,"bodySha256":"006bc09a1498874b1e271f6c8cf4cb88ceb7c2b5b6e42f684a3dd5157bb15c45","assertions":[{"pointer":"/code","kind":"equals","value":0,"passed":false,"actual":9,"exists":true}]}

复现步骤：

1. Use requirement MANAGED-READ at revision 1.
2. GET http://127.0.0.1:49328/target/bug without cookies or credentials; redirects are not followed.
3. Compare HTTP status, declared MIME and explicit JSON assertions/schema.

证据文件：

- contract：spec-2-READ-1-contract.json
- request：spec-2-READ-1-request.json
- response：spec-2-READ-1-response.json

## 边界

仅执行用户批准清单的 GET/HEAD，不跟随重定向、不携带会话或凭据。明确断言与支持的响应 schema 是本次真值；来源指纹用于追溯，不证明需求本身正确。未覆盖操作、未批准候选、网络/执行/响应/验证预算受阻不能通过。响应 JSON 保存在本地鉴权证据中；没有视觉、认证、数据库、写操作或完整业务状态机验收保证。
