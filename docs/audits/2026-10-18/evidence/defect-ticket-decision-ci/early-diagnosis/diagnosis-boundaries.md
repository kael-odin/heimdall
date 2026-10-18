# D6 精确 CI 早期失败诊断：响应体原件缺失

此记录是已完成 smoke job 的窄诊断，不是完整 CI 采集，不构成 CI 接受或产品通用通过结论。

- 仓库：kael-odin/heimdall
- HEAD：06e4303871d485a14b66d24318db80595a3db774
- Run / attempt：39096514869 / 1
- Job：117583999059，core (e2e smoke, local fixture)
- 失败步骤：Manual defect ticket decisions (four real UI races)
- Artifact：12124333500，manual-defect-ticket-decisions-1
- 原 ZIP SHA256：10947b600a60da1c800ebfcd5e344eaac434610024e56ebf675c9c5bc4d02894

## 已核对事实

唯一 action GET 对应动作号 `da-24c57ccf-074d-4577-8ded-3da4e45c6640`，Playwright 映射 ID 为 `ui-64b76888-e4b6-4802-b56b-d834bfb71a15`，CDP requestId 为 `3387.25`。

| UTC 时刻 | 原始事件 |
| --- | --- |
| 04:17:45.650 | relay 收到 action GET |
| 04:17:45.667 | CDP request |
| 04:17:45.679 | CDP response，HTTP 200，Transfer-Encoding: chunked，无 content-length |
| 04:17:45.683 | CDP failed，net::ERR_ABORTED，canceled: true；Playwright 同时 requestfailed |

该 GET 没有 loadingFinished / requestfinished。browser-requests 中 `finished: false`，browser-responses 中有 eager body readFailure，报 Network.getResponseBody No data found。局部 `.json()` 也失败并使 smoke 停在第一案。

原脚本全局 response 监听器已经在 action response 事件立即调用 body；因此不能以“仅把局部 json 提前”作为已证实修复。Playwright Response 的服务端 body Promise 还存在缓存，不能从两处调用就推断有两次底层 CDP body 读取。

failure-dom 中同一动作显示“服务端尚未给出此动作的完整原件。未查到记录不代表确定未提交，原确认继续保留。”及“原动作结果待核对 1”。UI 保留了原人工确认。因此 browser/CDP 原件读取失败不能直接等同于产品查询失败。

relay 在 04:17:45.868 的 original-upstream-error（socket hang up）属于受控保留的原 POST；不能直接归因给上述 action GET。

## 尚未证实的解释

精确 HEAD 静态代码没有 Response 与 body 之间显式 reload / goto；唯一 goto 早于四案。relay 只有最初的 GET /，但 CDP 记录器仅跟踪 API，且未专门采集 Page navigation 事件。因此不能仅凭 Playwright 错误文字确认导航根因，也不能在缺少专门导航记录时绝对排除导航。

现有事实只确认请求在收到响应后被浏览器记录为取消；取消源及具体机制需要额外复现证据。

## 原始材料

- `artifact-failure.json`、`artifact-summary.json`：原失败与整体完成状态。
- `network-diagnosis-20261018T043226958171Z/`：browser-responses、browser-errors、cdp-network、playwright-completions、browser-requests 的原字节与 manifest。
- `dom-relay-diagnosis-20261018T043511203557Z/`：failure DOM、原 unknown DOM、relay state events 与 relay JSONL 原字节及 manifest。
- `browser-runtime-diagnosis-20261018T043843685821Z/`：cdp-version、chromium.log 原字节及 manifest。

Browser 原件为 Chrome/153.0.8010.12，Protocol 1.3，V8 15.3.76.4，WebKit revision 971a7443b0c9b0a9b2860529b33331b76077ec62。chromium.log 只出现启动期 DBus / UPower / NetworkManager 相关诊断，没有足以解释上述取消的日志。

本诊断未运行 engine、浏览器、build 或测试，未修改源码、workflow、现有工具或 timeout。完整 CI 终态采集及原验证器结果另行保留。
