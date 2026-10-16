# 托管验收结果 · 项目验收报告

任务：ac-813e2ff2-ba0b-4ce1-b7cc-e2e9c3e3ebb2
模式：spec；时间：2026-10-16T22:09:33.660Z → 2026-10-16T22:09:33.664Z
需求来源：MANAGED-READ；版本：1
清单批准：未批准候选
来源指纹：49b4fa20a5a9b567b571afc993bec476652bc7e75b3ac59131f4e5542e658a4a
契约指纹：17a320bb33eb4806eb61917a7e885d031a3133577be9e8e9b269c01d88d183a0
目标：http://127.0.0.1:58796/source

计划指纹：03d61adc72b99b826c49432810c8e270d00284ada21ba4b7f167e7aaeb3be8fb
验证器指纹：e4214464d2fa64ee97ee957ec0777f329195251d7596a3fed0366bb188d5ece8

**门禁：阻断：存在未测/环境失败**

声明检查 2，已形成结果 2，完成可靠判定 0。
通过 0；失败 0；阻塞 2；待复核 0；目标缺陷 0；基线失败 0；缺测 0。

仅验收明确批准的 GET/HEAD 及声明的 HTTP、MIME、JSON 字段/响应 schema；不使用会话、不跟随重定向。候选、未覆盖契约、超时、超响应/验证预算均不能通过；无视觉、数据库、写操作、认证或任意业务状态机保证。来源指纹用于追溯，不代表系统已经证明原需求正确。

## 维度

| 维度 | 检查 | 通过 | 失败 | 阻塞 | 待复核 | 已测视觉分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 0 | 0 | 0 | 0 | 0 | 未测 |
| structure | 0 | 0 | 0 | 0 | 0 | 未测 |
| behavior | 2 | 0 | 0 | 2 | 0 | 未测 |
| health | 0 | 0 | 0 | 0 | 0 | 未测 |

## 检查明细

| ID | 路由 | 视口 | 状态 | 归因 | 严重程度 |
| --- | --- | --- | --- | --- | --- |
| spec-1-READ-0 | /healthy | api | blocked | needs_review | high |
| spec-2-READ-1 | /bug | api | blocked | needs_review | high |

## 问题与证据

### spec-1-READ-0 · 健康响应

结论：needs_review；证据等级：http-reproduced；参照：{"kind":"draft-spec","source":"MANAGED-READ","revision":"1","sourceFingerprint":"49b4fa20a5a9b567b571afc993bec476652bc7e75b3ac59131f4e5542e658a4a","documentSha256":null,"contractFingerprint":"17a320bb33eb4806eb61917a7e885d031a3133577be9e8e9b269c01d88d183a0"}
预期：{"status":200,"contentType":"application/json","json":[{"pointer":"/code","kind":"equals","value":0}]}
实际：{"requested":false,"reason":"Requirement candidate has not been explicitly approved."}

复现步骤：

1. Use requirement MANAGED-READ at revision 1.
2. GET http://127.0.0.1:58796/source/healthy without cookies or credentials; redirects are not followed.
3. Compare HTTP status, declared MIME and explicit JSON assertions/schema.

证据文件：

- contract：spec-1-READ-0-contract.json

### spec-2-READ-1 · 业务码符合需求

结论：needs_review；证据等级：http-reproduced；参照：{"kind":"draft-spec","source":"MANAGED-READ","revision":"1","sourceFingerprint":"49b4fa20a5a9b567b571afc993bec476652bc7e75b3ac59131f4e5542e658a4a","documentSha256":null,"contractFingerprint":"17a320bb33eb4806eb61917a7e885d031a3133577be9e8e9b269c01d88d183a0"}
预期：{"status":200,"contentType":"application/json","json":[{"pointer":"/code","kind":"equals","value":0}]}
实际：{"requested":false,"reason":"Requirement candidate has not been explicitly approved."}

复现步骤：

1. Use requirement MANAGED-READ at revision 1.
2. GET http://127.0.0.1:58796/source/bug without cookies or credentials; redirects are not followed.
3. Compare HTTP status, declared MIME and explicit JSON assertions/schema.

证据文件：

- contract：spec-2-READ-1-contract.json

## 边界

仅执行用户批准清单的 GET/HEAD，不跟随重定向、不携带会话或凭据。明确断言与支持的响应 schema 是本次真值；来源指纹用于追溯，不证明需求本身正确。未覆盖操作、未批准候选、网络/执行/响应/验证预算受阻不能通过。响应 JSON 保存在本地鉴权证据中；没有视觉、认证、数据库、写操作或完整业务状态机验收保证。
