import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith('/core/scripts/smoke-acceptance-browser-candidates-console.mjs')) {
      let source = String(result.source);
      const replacements = [
        ["const parse = file =>", "const diagnostic = value => fs.appendFileSync(join(OUT, 'diagnostic-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\\n');\nconst parse = file =>"],
        ["page.on('response', response => {", "page.on('response', response => { const at = new Date().toISOString(); if (new URL(response.url()).pathname === '/api/acceptance/runs') { diagnostic({event:'runs-response',receivedAt:at,status:response.status()}); if(response.status() >= 400) response.text().then(body => diagnostic({event:'runs-error-body',receivedAt:at,status:response.status(),body})).catch(cause => diagnostic({event:'body-unavailable',message:cause.message})); }"],
        ["fs.writeFileSync(reportFile, Buffer.concat([reportBytes, Buffer.from(' ')]));", "diagnostic({event:'before-intentional-report-edit',reportFile}); fs.writeFileSync(reportFile, Buffer.concat([reportBytes, Buffer.from(' ')])); diagnostic({event:'after-intentional-report-edit',reportFile});"],
        ["} finally { fs.writeFileSync(reportFile, reportBytes); }", "} finally { diagnostic({event:'before-report-restore',reportFile}); fs.writeFileSync(reportFile, reportBytes); diagnostic({event:'after-report-restore',reportFile}); }"]
      ];
      for (const [from, to] of replacements) {
        if (source.split(from).length !== 2) throw new Error('Diagnostic exact replacement mismatch: ' + from);
        source = source.replace(from, to);
      }
      return { ...result, source };
    }
    if (url.endsWith('/core/src/acceptance/managed-run-reader.mjs')) {
      const source = String(result.source), from = "const fail = (reason = 'INVALID_INPUT') => { throw new ManagedAcceptanceRunError('MANAGED_RUN_INTEGRITY_FAILED', reason); };";
      if (source.split(from).length !== 2) throw new Error('Diagnostic reader replacement mismatch');
      return { ...result, source: source.replace(from, "const fail = (reason = 'INVALID_INPUT') => { console.error(JSON.stringify({ diagnosticOnly: true, event: 'managed-reader-fence', at: new Date().toISOString(), reason, stack: new Error().stack })); throw new ManagedAcceptanceRunError('MANAGED_RUN_INTEGRITY_FAILED', reason); };") };
    }
    return result;
  }
});
