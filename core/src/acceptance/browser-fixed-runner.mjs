/** One explicit operation; the only live browser entry is the target release. */
import { runCompiledBrowserAcceptance } from './runner.mjs';

export function runFixedBrowserAcceptance(contract, options = {}) {
  return runCompiledBrowserAcceptance(contract, options);
}
