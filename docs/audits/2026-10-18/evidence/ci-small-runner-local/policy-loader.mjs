export async function load(url, context, nextLoad) {
  if (url === 'node:os') return {
    format: 'module', shortCircuit: true,
    source: 'export const availableParallelism = () => Number(process.env.HEIMDALL_POLICY_CPUS);',
  };
  if (url === 'node:child_process') return {
    format: 'module', shortCircuit: true,
    source: `export const spawnSync = (executable, args, options) => {
      process.stdout.write(JSON.stringify({ executable, args, cwd: options.cwd, stdio: options.stdio }));
      return { status: process.env.HEIMDALL_POLICY_STATUS === 'null' ? null : Number(process.env.HEIMDALL_POLICY_STATUS || 0) };
    };`,
  };
  return nextLoad(url, context);
}
