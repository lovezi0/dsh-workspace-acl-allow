// 发布前自检：环境无关、零依赖，CI（ubuntu）与本地（Windows）都能跑。
// 覆盖：提交的构建产物与源码一致、入口契约（服务依赖与导出面）、模块可加载、
// 非 Windows 的降级路径。Windows 专属逻辑（路由注册、来源围栏）由本地深度冒烟覆盖。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.log(`  FAIL ${label}${detail === '' ? '' : ` :: ${detail}`}`); }
};

console.log('A. 构建产物一致性（lib/ 随仓提交，必须与 src/ 同步）');
const srcEntry = read('src/index.mjs');
const libEntry = read('lib/index.js');
check('lib/index.js 与 src/index.mjs 逐字一致（先 npm run build）', srcEntry === libEntry);

const clientParts = ['00-head.js', '10-whitelist.js', '90-tail.js'].map((name) => read(`src/client/${name}`));
check('lib/client.js 等于客户端源片段拼接', read('lib/client.js') === clientParts.join('\n\n'));
check('不分发 lib/client/ 片段目录', !existsSync(join(root, 'lib', 'client')));

console.log('B. 入口契约');
check('导出 cordis 服务名', /export const name = "workspace-acl-allow"/.test(libEntry));
check('静态依赖为 webServer + webStartup', /export const inject = \["webServer", "webStartup"\]/.test(libEntry));
check('无 webRuntime 服务读取（已迁移）', !/ctx\.webRuntime/.test(libEntry));
check('导出 apply 与 Config', /export function apply\(/.test(libEntry) && /export const Config/.test(libEntry));

console.log('C. 元数据与打包');
const pkg = JSON.parse(read('package.json'));
check('peer 声明宿主最低版本', pkg.peerDependencies?.['@deepseek-ai/dsh'] === '>=0.2.1-alpha.1', String(pkg.peerDependencies?.['@deepseek-ai/dsh']));
check('files 含 lib 与 cordis.patch.yml', Array.isArray(pkg.files) && pkg.files.includes('lib') && pkg.files.includes('cordis.patch.yml'));
check('publishConfig 指向 npm 官方源', pkg.publishConfig?.registry === 'https://registry.npmjs.org/');

console.log('D. 模块可加载（宿主依赖缺席，用最小 schemastery 替身；data URL 免落盘）');
const stub = [
  'const __chain = () => { const node = {}; node.default = () => node; node.description = () => node; return node; };',
  'const Schema = { object: () => ({}), boolean: __chain, number: __chain, string: __chain, array: __chain };',
].join('\n');
const code = libEntry.replace('import Schema from "@deepseek-ai/schemastery";', stub);
check('入口 import 形态与替身替换点一致', code !== libEntry);

const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
check('加载后 name 正确', mod.name === 'workspace-acl-allow', String(mod.name));
check('加载后 inject 精确为 [webServer, webStartup]', JSON.stringify(mod.inject) === JSON.stringify(['webServer', 'webStartup']), JSON.stringify(mod.inject));
check('加载后 apply 与 Config 就绪', typeof mod.apply === 'function' && mod.Config !== undefined);

if (process.platform === 'win32') {
  console.log('  skip 非 Windows 降级路径（当前平台为 Windows）');
} else {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  let ok = true;
  let detail = '';
  try { await mod.apply({ logger }, {}); } catch (error) { ok = false; detail = String(error); }
  check('非 Windows 上 apply 走降级且不抛错', ok, detail);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
