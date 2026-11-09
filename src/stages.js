/** Keep successful stages when a later stage is retried. Never memoize failures. */
export async function stage(checkpoint, name, work) {
  checkpoint.values ||= {}; checkpoint.timings ||= {};
  if (Object.hasOwn(checkpoint.values,name)) return checkpoint.values[name];
  checkpoint.onStage?.(name,'started');
  const started = performance.now();
  try {
    const value = await work(); checkpoint.values[name] = value;
    return value;
  } finally {
    checkpoint.timings[name] = (checkpoint.timings[name] || 0) + performance.now() - started;
    checkpoint.onStage?.(name,Object.hasOwn(checkpoint.values,name) ? 'completed' : 'failed',checkpoint.timings[name]);
  }
}
