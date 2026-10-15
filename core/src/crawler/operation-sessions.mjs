/**
 * Split an operation flow at explicit session switches.
 *
 * A `useSession` action is not a page action. It tells the runner to close the
 * current browser context and continue from the same URL in another saved
 * login state (or in a fresh anonymous context when `sessionName` is null).
 */
export function operationSessionSegments(flow) {
  const segments = [{ sessionName: flow?.sessionName ?? null, actions: [] }];
  for (const action of flow?.actions ?? []) {
    if (action?.type === 'useSession') {
      segments.push({ sessionName: action.sessionName ?? null, actions: [] });
      continue;
    }
    segments[segments.length - 1].actions.push(action);
  }
  return segments;
}
