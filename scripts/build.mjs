import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function requireFile(path) {
  if (!existsSync(join(root, path))) {
    console.error(`Missing required file: ${path}`);
    process.exit(1);
  }
}

function pruneGenerated(path) {
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path)) {
    const fullPath = join(path, entry);
    if (entry === "__pycache__") {
      rmSync(fullPath, { recursive: true, force: true });
      continue;
    }
    if (statSync(fullPath).isDirectory()) {
      pruneGenerated(fullPath);
    }
  }
}

for (const path of [
  "public/index.html",
  "public/app.js",
  "public/core.js",
  "public/styles.css",
  "server/app.py",
  "server/ml_pipeline.py",
  "server/mask_utils.py",
]) {
  requireFile(path);
}

run("node", ["--check", "public/core.js"]);
run("node", ["--check", "public/app.js"]);
run("python3", [
  "-c",
  "import ast, pathlib; [ast.parse(path.read_text(), filename=str(path)) for path in pathlib.Path('server').glob('*.py')]",
]);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(root, "public"), join(dist, "public"), { recursive: true });
cpSync(join(root, "server"), join(dist, "server"), { recursive: true });
cpSync(join(root, "README.md"), join(dist, "README.md"));
pruneGenerated(dist);

console.log("Build completed: dist/");
