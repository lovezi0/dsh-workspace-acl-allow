// 构建脚本：纯 node，零依赖。
// 入口约定：src/index.mjs → lib/index.js（package.json main 指向 lib/index.js）；
//          src/client/*.js → lib/client.js（浏览器 bundle 单文件）。
// 浏览器模块系统不支持插件相对 require，多文件必须零依赖拼接为一个 bundle。
import { mkdirSync, cpSync, copyFileSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// npm run build 运行时 cwd 即为包根目录。
const root = process.cwd();
const src = join(root, "src");
const lib = join(root, "lib");
mkdirSync(lib, { recursive: true });

// 递归复制整个 src/ 到 lib/。
if (existsSync(src)) cpSync(src, lib, { recursive: true });

// 服务端入口：src/index.mjs → lib/index.js（与 package.json main 对齐）。
copyFileSync(join(src, "index.mjs"), join(lib, "index.js"));
// 递归复制产生的 lib/index.mjs 与重命名后的入口内容重复，删除。
try { rmSync(join(lib, "index.mjs"), { force: true }); } catch {}

// 浏览器 bundle：src/client/ 按序拼接 → lib/client.js（自包含单文件）。
// 顺序即闭包作用域依赖顺序：head 定义 module/exports/React，中间定义组件，tail 定义 apply 并导出。
const CLIENT_PARTS = [
  "00-head.js",
  "10-whitelist.js",
  "90-tail.js",
];
const clientDir = join(src, "client");
const clientSource = CLIENT_PARTS.map((f) => readFileSync(join(clientDir, f), "utf8")).join("\n\n");
writeFileSync(join(lib, "client.js"), clientSource);
// parts 已拼入 lib/client.js，不随包分发 lib/client/。
try { rmSync(join(lib, "client"), { recursive: true, force: true }); } catch {}

console.log("built lib/ from src/ (recursive copy + index.js entry rename + client bundle concat)");
