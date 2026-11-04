// Hilight settings come from HILIGHT_* environment variables. Each one falls back to the
// LAVISH_AXI_* name it had before the rename, so existing shells, services, and hooks keep
// working. A HILIGHT_* variable that is set, even to an empty string, wins.
/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} name setting name without prefix, e.g. "STATE_DIR"
 * @returns {string | undefined}
 */
export function readEnv(env, name) {
  const current = env[`HILIGHT_${name}`];
  if (current !== undefined) return current;
  return env[`LAVISH_AXI_${name}`];
}
