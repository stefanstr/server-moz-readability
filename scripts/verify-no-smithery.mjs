import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const forbiddenFiles = ["smithery.yaml", "Dockerfile"];
const docFiles = ["readme.md"];
const hits = [];

for (const file of forbiddenFiles) {
  if (existsSync(join(repoRoot, file))) {
    hits.push(`Forbidden file present: ${file}`);
  }
}

for (const file of docFiles) {
  const fullPath = join(repoRoot, file);
  const contents = readFileSync(fullPath, "utf8");
  if (/smithery/i.test(contents)) {
    hits.push(`Found forbidden reference in ${file}`);
  }
}

if (hits.length > 0) {
  console.error("Smithery cleanup check failed:");
  for (const hit of hits) {
    console.error(`- ${hit}`);
  }
  process.exit(1);
}

console.log("Smithery cleanup check passed.");
