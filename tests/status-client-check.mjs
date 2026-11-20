import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
let spec;
const events = new Map();
const doc = { getElementById: () => null, createElement: () => ({ remove() {} }), head: { appendChild() {} } };
const win = { __ModuleLoader__: { load: x => { spec = x; } }, addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) };
let hooks = [], cursor = 0, effects = [];
const React = {
  createElement: (type, props) => ({ type, props }),
  useState: init => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof init === "function" ? init() : init; return [hooks[i], v => { hooks[i] = v; }]; },
  useEffect: (fn, deps) => { const i = cursor++; const prev = hooks[i]; if (!prev || !deps.every((d, k) => d === prev.deps[k])) { prev?.off?.(); hooks[i] = { deps, off: fn() }; } },
};
new Function("window", "document", readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"))(win, doc);
const mod = spec.factory(n => n === "react" ? React : n === "react-dom" ? {} : { Switch() {} });
const Inner = () => null;
const entry = { options: { key: "assistant-step" }, component: Inner };
let changed;
let off = false;
const ctx = {
  effect: fn => { const d = fn(); if (typeof d === "function") effects.push(d); },
  slots: { entries: () => [entry], subscribe: (_, fn) => { changed = fn; return () => { off = true; }; }, inject() {} },
  locale: { register: () => () => {}, bind: () => () => "" },
};
mod.apply(ctx);
const Wrapper = entry.component;
assert.notEqual(Wrapper, Inner);
changed();
assert.equal(entry.component, Wrapper, "重入不能重复包装");
let requests = 0;
globalThis.fetch = async () => { requests++; return { ok: true, json: async () => ({ ok: true, summon: { name: "探针" } }) }; };
const text = '> **Status_Bar**:\n>   **Location**: "书房"\n>   **User_List**:\n>     - User:\n>         **Name**: "林川"';
const node = { data: { status: "settled", blocks: [{ kind: "text", text }, { kind: "reasoning", text: "内部过程" }] } };
const before = JSON.stringify(node);
const render = props => { cursor = 0; return Wrapper(props); };
const props = { sessionId: "test-sid", node, custom: "keep" };
assert.equal(render(props).props.node, node, "状态查询前原样显示");
await new Promise(resolve => setImmediate(resolve));
let output = render(props);
assert.equal(requests, 1);
assert.notEqual(output.props.node, node);
assert.match(output.props.node.data.blocks[0].text, /\*\*地点\*\*: 书房/);
assert.equal(output.props.node.data.blocks[1], node.data.blocks[1], "推理块不动");
assert.equal(output.props.custom, "keep");
assert.equal(JSON.stringify(node), before, "原始消息和历史不修改");
events.get("dcs:status")({ detail: { sid: "test-sid", summon: null } });
assert.equal(render(props).props.node, node, "解除召唤后停止转换");
events.get("dcs:status")({ detail: { sid: "test-sid", summon: { name: "探针" } } });
assert.notEqual(render(props).props.node, node, "再次召唤后恢复转换");
const other = render({ ...props, sessionId: "other-sid" });
assert.equal(other.props.node, node, "切换会话不能沿用前一个会话的启用态");
for (const d of effects.reverse()) d();
assert.equal(entry.component, Inner, "卸载恢复原渲染器");
assert.equal(off, true);
assert.equal(events.has("dcs:status"), false);
console.log("15 项客户端状态显示接线断言通过");
