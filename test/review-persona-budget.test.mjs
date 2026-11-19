// 在 Electron 的 Node 模式运行；只读现有文件，不创建或删除临时对象。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [project, dshHome, loaderPath, guardPath, personaPath] = process.argv.slice(2);
assert.ok(personaPath, '需要项目、DSH 用户目录、真实加载器、核验器与人设路径');
const { loadBaselineInstructions } = await import(pathToFileURL(resolve(loaderPath)).href);
const { readSource, verifyRequest } = await import(pathToFileURL(resolve(guardPath)).href);
const source = readSource(personaPath);
const bridge = readFileSync(new URL('../lib/review-bridge.mjs', import.meta.url), 'utf8');
const overlay = bridge.match(/const REVIEW_OVERLAY = `([^`]+)`/u)?.[1];
assert.ok(overlay, '未找到外审独立启动补丁');
assert.match(overlay, /mode: read-only/u);
assert.match(overlay, /sandbox: read-only/u);
assert.match(overlay, /approval: never/u);
const budget = Number(overlay.match(/- id: agent-instructions\s+config:\s+maxBytes: (\d+)/u)?.[1] ?? 65536);
const baseline = await loadBaselineInstructions({ cwd: project, dshHome, maxBytes: 65536 });
const fixed = await loadBaselineInstructions({ cwd: project, dshHome, maxBytes: budget });
const shape = v => ({ bytes: Buffer.byteLength(v.text), fullPersona: v.text.includes(source.text),
  omitted: v.omitted.map(x => x.displayPath), truncated: v.truncated });
console.log(JSON.stringify({ baseline: shape(baseline), configuredBudget: budget, candidate: shape(fixed) }));
assert.equal(fixed.text.includes(source.text), true, '外审必须保留当前人设全文');
assert.deepEqual(fixed.omitted, []);
assert.deepEqual(fixed.truncated, []);
const request = (text, action = 'add') => ({ messages: [{ role: 'user',
  source: { kind: 'agent-instructions', changes: [{ scope: 'user-global\u0000AGENTS.md', action }] },
  content: [{ type: 'text', text }] }] });
assert.equal(verifyRequest(request(fixed.text), source).fullText, true);
assert.throws(() => verifyRequest({ messages: [] }, source), /缺少用户级人设指令/u);
assert.throws(() => verifyRequest(request(source.text.slice(0, -1)), source), /不完整/u);
assert.throws(() => verifyRequest(request(fixed.text, 'remove'), source), /已移除/u);
console.log(JSON.stringify({ result: 'PASS', controls: 7, guardEnforced: true, sourceBytes: source.bytes,
  sourceSha256: source.sha256, writes: 0, productImported: false }));
