#!/usr/bin/env node
import { isVersionOnlyArgv, VERSION } from "../src/version.js";

// The version probe answers from a leaf module; everything else loads the CLI.
const argv = process.argv.slice(2);
if (isVersionOnlyArgv(argv)) {
  process.stdout.write(`${VERSION}\n`);
} else {
  const { run } = await import("../src/cli.js");
  await run(argv);
}
