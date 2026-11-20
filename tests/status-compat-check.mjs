import assert from "node:assert/strict";
import { normalizeStatusText, statusBodyToMarkdown } from "../lib/status-compat.js";
import { markdownizeText } from "../lib/markdownize.js";
let pass = 0;
function test(name, fn) { fn(); pass++; console.log(`✓ ${name}`); }
const yaml = `Status_Bar:
  Date_and_Time: "2026年11月10日 12点00分"
  Location: "书房"
  User_List:
    - User:
        Name: "林川"
        Action: "翻书"
        Custom_Field: "0: 未知 | 待定"
        Recent_Sexual_Activity:
          - "无"
          - "无"
    - User:
        Name: "许遥"
        Outfit: "蓝色外套"
  Action_Options:
    Name: "林川"
    Options:
      - "继续阅读"
      - "合上书页"`;
const quote = yaml.split("\n").map(s => "> " + s.replace(/^(\s*)([A-Za-z_]+):/, "$1**$2**:")).join("\n");
const formatted = statusBodyToMarkdown(yaml);
test("每个 YAML 字段成为独立列表项", () => {
  assert.match(formatted, /^- \*\*时间\*\*: /m);
  assert.match(formatted, /^  - \*\*角色\*\*:/m);
  assert.match(formatted, /^    - \*\*姓名\*\*: 林川/m);
});
test("两个角色、重复列表项与未知字段不丢", () => {
  assert.equal((formatted.match(/- 无/g) ?? []).length, 2);
  assert.match(formatted, /许遥/);
  assert.match(formatted, /Custom\\_Field/);
  assert.match(formatted, /0: 未知 \\| 待定/);
});
test("旧 Markdown 引用块在显示时转换", () => {
  const result = normalizeStatusText(`正文\n\n${quote}\n\n后文`);
  assert.match(result, /^正文/);
  assert.match(result, /\*\*姓名\*\*: 林川/);
  assert.ok(result.endsWith("\n\n后文"));
  assert.ok(!result.includes("> **Status_Bar**"));
});
test("完整标签与 YAML 围栏共用转换器", () => {
  for (const s of [`\`\`\`<StatusBar>\n${yaml}\n</StatusBar>\`\`\``, `<StatusBar>\n${yaml}\n</StatusBar>`,  `\`\`\`yaml\n${yaml}\n\`\`\``, `\`\`\`\n<StatusBar>\n${yaml}\n</StatusBar>\n\`\`\``]) {
    const result = normalizeStatusText(s);
    assert.match(result, /\*\*地点\*\*: 书房/);
    assert.ok(!result.includes("```"));
    assert.ok(!result.includes("<StatusBar>"));
  }
});
test("流式未闭合块及未识别文本原样保留", () => {
  const partial = `<StatusBar>\n${yaml}`;
  assert.equal(normalizeStatusText(partial, { streaming: true }), partial);
  assert.equal(normalizeStatusText(quote, { streaming: true }), quote);
  assert.equal(normalizeStatusText("普通文本 > 引用\n- 清单"), "普通文本 > 引用\n- 清单");
});
test("转换幂等", () => {
  const once = normalizeStatusText(quote);
  assert.equal(normalizeStatusText(once), once);
});
test("值中的标签和 Markdown 不变成活动内容", () => {
  const result = statusBodyToMarkdown('Status_Bar:\n  Location: "<img src=x onerror=alert(1)> [跳转](javascript:x)"');
  assert.ok(!result.includes("<img"));
  assert.match(result, /&lt;img/);
  assert.match(result, /\\\[跳转\\\]/);
});
test("模板宏在转换后仍可求值", () => {
  const result = markdownizeText('<StatusBar>\nStatus_Bar:\n  Location: "{{<user>}} {{foo_bar}}"\n</StatusBar>');
  assert.ok(result.includes("{{user}}"));
  assert.ok(result.includes("{{foo_bar}}"));
});
test("不再添加格式提示词", () => {
  assert.equal(markdownizeText('- 外层必须用<StatusBar></StatusBar>再用代码块(```)包裹'), "");
});
test("无法识别时保留 CRLF 与未闭合围栏", () => {
  const raw = "提到 StatusBar 的普通段落\r\n后文";
  assert.equal(normalizeStatusText(raw), raw);
  const partialFence = `\`\`\`yaml\n${yaml}\n`;
  assert.equal(normalizeStatusText(partialFence, { streaming: true }), partialFence);
});
test("文字状态栏的 details/summary 不泄漏成标签", () => {
  const result = normalizeStatusText('<Status_block>\n<details><summary>角色状态</summary>\n- 当前行动：翻书\n</details>\n</Status_block>');
  assert.ok(!result.includes("details"));
  assert.ok(!result.includes("summary"));
  assert.match(result, /角色状态/);
  assert.match(result, /翻书/);
});
console.log(`${pass} 通过 / 0 失败`);
