# API before · 项目验收报告

任务：ac-7e7479b4-3d7c-4760-978b-54bb43318aeb
模式：spec；时间：2026-10-16T12:12:39.213Z → 2026-10-16T12:12:39.236Z
需求来源：REQ-COMPARISON；版本：v1
清单批准：已显式声明批准
来源指纹：d2882e9edf5b33bd01c26e5f4c84b8ac218200ecefb46c592e5d98db61ad8ff1
契约指纹：cd9e9e05e159d7bb7c86a90a0823350160d96632ee846b38218c8263a98a1844
目标：http://127.0.0.1:53572/api/before

计划指纹：767597a15fc0f06a73823ac7927d7ddc3494eb11dfa777e7cdf766145ab7efa1
验证器指纹：8d8be9db16df0c5e021f13dcb474edf6629688b804ab523a6e7d415b6538703d

**门禁：阻断：发现缺陷**

声明检查 2，已形成结果 2，完成可靠判定 2。
通过 1；失败 1；阻塞 0；待复核 0；目标缺陷 1；基线失败 0；缺测 0。

离线复现：本机固定版本、缺陷和假关闭反例，通过真实 browser/Spec runner、store 落盘与当前证据校验完成；只证明本组声明范围，不代表真实项目检出率、根因识别或持久缺陷自动关闭。

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
| spec-1-quota | /quota | api | failed | bug | high |
| spec-2-items | /items | api | passed | match | high |

## 问题与证据

### spec-1-quota · Contract quota

结论：bug；证据等级：http-reproduced；参照：{"kind":"approved-spec","source":"REQ-COMPARISON","revision":"v1","sourceFingerprint":"d2882e9edf5b33bd01c26e5f4c84b8ac218200ecefb46c592e5d98db61ad8ff1","documentSha256":null,"contractFingerprint":"cd9e9e05e159d7bb7c86a90a0823350160d96632ee846b38218c8263a98a1844"}
预期：{"status":200,"contentType":"application/json","json":[{"pointer":"/code","kind":"equals","value":0}]}
实际：{"requested":true,"httpStatus":200,"contentType":"application/json","redirectNotFollowed":false,"hasLocation":false,"mismatches":[{"kind":"equals","pointer":"/code","value":0,"passed":false,"actual":400,"exists":true}],"bytes":22,"bodySha256":"cddd23c146601b8d23bb2cd88910c7203a540b49bda683b9ba99c699f9aef089","assertions":[{"pointer":"/code","kind":"equals","value":0,"passed":false,"actual":400,"exists":true}]}

复现步骤：

1. Use requirement REQ-COMPARISON at revision v1.
2. GET http://127.0.0.1:53572/api/before/quota without cookies or credentials; redirects are not followed.
3. Compare HTTP status, declared MIME and explicit JSON assertions/schema.

证据文件：

- contract：spec-1-quota-contract.json
- request：spec-1-quota-request.json
- response：spec-1-quota-response.json

## 边界

仅执行用户批准清单的 GET/HEAD，不跟随重定向、不携带会话或凭据。明确断言与支持的响应 schema 是本次真值；来源指纹用于追溯，不证明需求本身正确。未覆盖操作、未批准候选、网络/执行/响应/验证预算受阻不能通过。响应 JSON 保存在本地鉴权证据中；没有视觉、认证、数据库、写操作或完整业务状态机验收保证。
