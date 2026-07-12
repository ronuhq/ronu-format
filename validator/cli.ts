// Validate a .ronu module.json from the command line.
//
//   npx -y tsx validator/cli.ts <path-to-module.json> [more...]
//
// Exit code 0 = every file valid (warnings allowed), 1 = any errors.

import { readFileSync } from "fs";
import { validateModuleContent } from "./index";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: tsx validator/cli.ts <module.json> [module.json ...]");
  process.exit(2);
}

let failed = false;
for (const file of files) {
  let content: unknown;
  try {
    content = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`${file}: unreadable or not JSON — ${(e as Error).message}`);
    failed = true;
    continue;
  }
  const result = validateModuleContent(content);
  const flag = result.valid ? "VALID" : "INVALID";
  console.log(
    `${file}: ${flag} (${result.errors.length} errors, ${result.warnings.length} warnings)`
  );
  for (const issue of result.errors) console.log(`  error  ${issue.code}  ${issue.message}`);
  for (const issue of result.warnings) console.log(`  warn   ${issue.code}  ${issue.message}`);
  if (!result.valid) failed = true;
}
process.exit(failed ? 1 : 0);
