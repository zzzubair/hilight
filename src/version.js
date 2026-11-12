// A leaf module (node builtins only), so `hilight --version` answers before the CLI graph loads.
// The build inlines LAVISH_AXI_BUILD_VERSION; a source run reads package.json.
import { readFileSync } from "node:fs";

export const VERSION =
  process.env.LAVISH_AXI_BUILD_VERSION ||
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export function isVersionOnlyArgv(argv) {
  return argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "-V");
}
