# D6 response body failure: independent read-only review

- Scope: exact source HEAD `06e4303871d485a14b66d24318db80595a3db774`, failed Linux run `39096514869`, attempt `1`, job `117583999059`, artifact `12124333500`.
- Evidence level: current source and original artifact analysis only. No engine, Chromium, browser script, test, CI collection, or maintenance edit was performed by this reviewer.
- Do not interpret this report as a passing CI result or a verified fix.

## Confirmed facts

1. The failing browser action GET is UI id `ui-64b76888-e4b6-4802-b56b-d834bfb71a15`, CDP request `3387.25`, original action `da-24c57ccf-074d-4577-8ded-3da4e45c6640`.
2. Original captured ordering is 04:17:45.667 UTC request, .679 response HTTP 200, .683 `Network.loadingFailed` with `net::ERR_ABORTED` / `canceled:true`. There is no loadingFinished for that GET. Playwright reports requestfailed; browser-requests records finished:false. The response was chunked, no Content-Length, with application/json and no-store.
3. The eager response body read already fails for this same GET. `startBrowser` synchronously invokes `response.body()` for every /defect-tickets/actions/ response (smoke source lines 143–150). Therefore moving `.json()` into `waitForResponse().then(...)` does not establish an earlier server-side body read or repair the initiating failure.
4. Local installed Playwright is 1.63.0. In `core/node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/lib/coreBundle.js`:
   - Response.internalBody (13883–13901) caches its first promise, waits for _finishedPromise, then invokes its response body callback.
   - Chromium _onLoadingFailed (36376–36400) also calls response._requestFinished, resolving that promise for a response that failed after headers.
   - The body callback (36436–36470) issues Network.getResponseBody for the same request id. For this non-refetch-safe API fetch there is no safe reload fallback.
   - internalBody adds the navigated-away advice to every protocol error of type error (13894–13898); this message is not a measured navigation event.
5. Failure DOM from this same ZIP contains the expected unresolved notice: 服务端尚未给出此动作的完整原件。未查到记录不代表确定未提交，原确认继续保留。 It still contains one pending original. The product only emits that notice after its own bounded stream reader, JSON parse, and defectTicketAction validation have succeeded (AcceptanceDefectTickets.vue 183–197; acceptance-defect-tickets.js 341–356, 383–401). Thus the artifact supports successful UI consumption of the expected read-only response despite the DevTools completion/body retrieval failure.
6. The fixture relay streams ordinary responses at headers/data, ending them on native upstream end (defect-ticket-decision-relay.mjs 47–60). It strips hop headers and the engine JSON helper does not declare Content-Length. The controlled 502 in the same case is explicitly bounded to 125 bytes with Content-Length and correctly finished in both CDP and Playwright.
7. No product-side explicit AbortController abort occurs in requestDefectTickets cleanup; it clears the deadline and removes the outer signal listener. Guard aborts exist for context reset, channel replacement, storage changes and unmount. The source alone does not prove which, if any, fired on this request.
8. Same-ZIP browser runtime is Chrome/153.0.8010.12, Protocol 1.3, V8 15.3.76.4, WebKit 537.36 (@971a7443b0c9b0a9b2860529b33331b76077ec62). The retained Chromium log only contains startup DBus/UPower/NetworkManager warnings and the DevTools listening line, with no concrete crash, navigation or body cause. These facts come from the separately manifested browser-runtime-diagnosis-20261018T043843685821Z narrow extraction.

## Precise conclusion and limits

The immediate failure is real CDP/Playwright loss of the action GET response body after Network.loadingFailed. Its initiating cancel is not yet established. It is incorrect to call this a navigation bug, incorrect to claim only a delayed .json() read, and premature to claim the product reconcile operation failed: the same failure DOM proves its expected unresolved path rendered.

The script has one explicit page.goto, and the relay log has one document GET /. Existing CDP instrumentation records API traffic, not Page.frameNavigated / Runtime execution-context events. This supports no observed second document request, not an absolute proof that no navigation occurred.

The retained original POST socket-hang-up event occurs during failure cleanup (.868), after the GET error; it must not be presented as the cause of the preceding GET.

## Smallest candidate that retains the old strict assertions

If the root baseline reproduces or rules out environment differences and the next experiment is a fixture repair, limit it to the ordinary action GET / deny forwarding. Collect the native upstream response in a bounded buffer until its real end, preserve the actual status and non-hop headers, set an exact Content-Length, and send those same bytes through res.end(bytes). Record native response end, bytes and SHA. Do not retry or refetch.

This preserves native UI dispatch, one upstream request, full original bytes, expected status, exact result proofs, UI state and storage checks, Playwright body acquisition, and the unchanged independent verifier. It should be treated as an experiment until the complete four-case smoke, unchanged strict verifier and new exact-head Linux CI succeed. Chunked/no-length framing is a correlation in the current evidence, not a proven root cause.

Browser-side fetch-clone or AbortController/reader-stage instrumentation may help establish the initiating cancel, but must not be used as a silent successful fallback that masks readFailure or replaces the old strict response-body proof. Do not widen error filters, add retries, enlarge timeouts, or modify production/old verifier based on this evidence alone.

## Evidence read

- `core/workspace/_runs/d6-ci-20261018/early-job-diagnosis-39096514869-117583999059-20261018T0420190270097Z/artifact-diagnosis-result.json`
- Same directory: `network-diagnosis-20261018T043226958171Z/{browser-requests,browser-responses,cdp-network,playwright-completions,browser-errors}.json`
- Same directory: `dom-relay-diagnosis-20261018T043511203557Z/{failure-dom.txt,relay.jsonl,relay-state-events.json}`
- Current maintained smoke, relay, frontend request/reconcile, service action and engine JSON helper, plus installed Playwright coreBundle.js.

