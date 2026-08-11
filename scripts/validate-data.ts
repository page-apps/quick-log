import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { quickLogCollectionSchema } from "../src/lib/schema.ts";

const targets = ["data/records.json", "demo/records.json"];
let failed = false;

for (const target of targets) {
  try {
    const text = await readFile(resolve(process.cwd(), target), "utf8");
    const result = quickLogCollectionSchema.safeParse(JSON.parse(text));
    if (!result.success) {
      failed = true;
      console.error(`${target}: invalid`);
      for (const issue of result.error.issues) {
        console.error(`  ${issue.path.join(".") || "root"}: ${issue.message}`);
      }
      continue;
    }
    console.log(`${target}: ${result.data.records.length} valid record(s)`);
  } catch (error) {
    failed = true;
    console.error(`${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed) process.exitCode = 1;
