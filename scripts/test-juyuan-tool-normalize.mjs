/**
 * Regression fixtures for JuYuan / Qwen tool-call shapes that previously
 * leaked XML into chat or failed schema validation (arg_key/arg_value).
 *
 * Run: node scripts/test-juyuan-tool-normalize.mjs
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";

const proxyPath = new URL("./juyuan-sse-proxy.mjs", import.meta.url);
const src = readFileSync(proxyPath, "utf8");
const exported =
  src
    .replace(
      "const server = http.createServer",
      "export { normalizeCompletionPayload, extractToolCallsFromText };\nconst server = http.createServer",
    )
    .replace(
      "server.listen(",
      'if (process.env.JUYUAN_PROXY_TEST === "1") { /* no listen */ } else server.listen(',
    );
const modPath = new URL("./_proxy_normalize_mod.mjs", import.meta.url);
writeFileSync(modPath, exported);
process.env.JUYUAN_PROXY_TEST = "1";

const { normalizeCompletionPayload, extractToolCallsFromText } = await import(
  modPath.href + `?t=${Date.now()}`
);

function payloadFromContent(content, toolCalls) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "qwen3_6_plus",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  };
}

function argsOf(out) {
  return out.choices[0].message.tool_calls?.map((t) => ({
    name: t.function?.name,
    args: JSON.parse(t.function?.arguments || "{}"),
  }));
}

const cases = [];

function check(name, fn) {
  try {
    fn();
    cases.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    cases.push({ name, ok: false, err: String(err?.message || err) });
    console.error(`FAIL  ${name}: ${err?.message || err}`);
  }
}

check("native tool_calls arg_key/arg_value → command", () => {
  const out = normalizeCompletionPayload(
    payloadFromContent(
      "先看一下。\n\n<tool_call>\n\n<tool_call>\n\n<tool_call>",
      [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "exec",
            arguments: JSON.stringify({
              arg_key: "command",
              arg_value: "echo hi",
            }),
          },
        },
      ],
    ),
  );
  const msg = out.choices[0].message;
  if (msg.content && /tool_call/i.test(msg.content)) {
    throw new Error(`leaked tool_call in content: ${msg.content}`);
  }
  if (msg.content !== "先看一下。") {
    throw new Error(`unexpected content: ${JSON.stringify(msg.content)}`);
  }
  const a = argsOf(out)[0];
  if (a.name !== "exec" || a.args.command !== "echo hi" || a.args.arg_key) {
    throw new Error(JSON.stringify(a));
  }
  if (out.choices[0].finish_reason !== "tool_calls") {
    throw new Error(`finish_reason=${out.choices[0].finish_reason}`);
  }
});

check("native tool_calls arg_key path for read", () => {
  const out = normalizeCompletionPayload(
    payloadFromContent("reading", [
      {
        id: "call_2",
        type: "function",
        function: {
          name: "read",
          arguments: JSON.stringify({
            arg_key: "path",
            arg_value: "E:\\x\\SKILL.md",
          }),
        },
      },
    ]),
  );
  const a = argsOf(out)[0];
  if (a.args.path !== "E:\\x\\SKILL.md" || a.args.arg_key) {
    throw new Error(JSON.stringify(a));
  }
});

check("text XML function=name, {json} without </function>", () => {
  const text = `<tool_call>
<function=read, {"path": "tool-ping.txt"}
</tool_call>`;
  const extracted = extractToolCallsFromText(text);
  if (!extracted?.toolCalls?.[0]) throw new Error("no extract");
  const args = JSON.parse(extracted.toolCalls[0].function.arguments);
  if (args.path !== "tool-ping.txt") throw new Error(JSON.stringify(args));
});

check("text XML function=name, parameters={json}", () => {
  // Live session had an extra trailing `}` after the JSON object.
  const text = `<tool_call>
<function=read, parameters={"path": "E:\\\\ai_claw\\\\package.json"}}
</tool_call>`;
  const extracted = extractToolCallsFromText(text);
  if (!extracted?.toolCalls?.[0]) throw new Error("no extract");
  const args = JSON.parse(extracted.toolCalls[0].function.arguments);
  if (args.path !== "E:\\ai_claw\\package.json") {
    throw new Error(JSON.stringify(args));
  }
});

check("prose + <exec><command>", () => {
  const text = `Let me check the OpenClaw docs for Feishu integration.
<exec>
<command>Get-ChildItem -Path "E:\\openclaw-main\\docs" -Filter "feishu"</command>
</exec>`;
  const out = normalizeCompletionPayload(payloadFromContent(text));
  const a = argsOf(out)[0];
  if (a?.name !== "exec" || !String(a.args.command).includes("Get-ChildItem")) {
    throw new Error(JSON.stringify(a));
  }
  if (/<exec>|tool_call/i.test(out.choices[0].message.content || "")) {
    throw new Error(`leaked: ${out.choices[0].message.content}`);
  }
});

check("arg_key/arg_value XML pairs", () => {
  const text = `<tool_call>
<function=read>
<arg_key>path</arg_key>
<arg_value>/tmp/a.txt</arg_value>
</tool_call>`;
  const extracted = extractToolCallsFromText(text);
  const args = JSON.parse(extracted.toolCalls[0].function.arguments);
  if (args.path !== "/tmp/a.txt") throw new Error(JSON.stringify(args));
});

check("dangling empty <tool_call> tags only → stripped, no fake tools", () => {
  const out = normalizeCompletionPayload(
    payloadFromContent("说明一下步骤。\n\n<tool_call>\n<tool_call>\n<tool_call>"),
  );
  const msg = out.choices[0].message;
  if (msg.tool_calls?.length) throw new Error("should not invent tools");
  if (/tool_call/i.test(msg.content || "")) {
    throw new Error(`leaked: ${msg.content}`);
  }
  if (msg.content !== "说明一下步骤。") {
    throw new Error(JSON.stringify(msg.content));
  }
});

check("tool-only unparseable tags must not wipe to empty content", () => {
  const raw = "<tool_call>\n<tool_call>\n<tool_call>";
  const out = normalizeCompletionPayload(payloadFromContent(raw));
  const msg = out.choices[0].message;
  if (msg.tool_calls?.length) throw new Error("should not invent tools");
  // Keep original so core repair / next turn can recover; UI strip hides tags.
  if (!msg.content || msg.content.length === 0) {
    throw new Error("content was wiped empty");
  }
});

check("empty-arg extracted tools are rejected (no silent wipe)", () => {
  const out = normalizeCompletionPayload(
    payloadFromContent("hello", [
      {
        id: "call_empty",
        type: "function",
        function: { name: "read", arguments: "{}" },
      },
    ]),
  );
  if (out.choices[0].message.tool_calls?.length) {
    throw new Error("empty-arg tool_calls should be dropped");
  }
  if (out.choices[0].message.content !== "hello") {
    throw new Error(JSON.stringify(out.choices[0].message.content));
  }
});

check("stacked arg_key arrays", () => {
  const out = normalizeCompletionPayload(
    payloadFromContent(null, [
      {
        id: "call_3",
        type: "function",
        function: {
          name: "read",
          arguments: JSON.stringify({
            arg_key: ["path", "offset"],
            arg_value: ["a.txt", 0],
          }),
        },
      },
    ]),
  );
  const a = argsOf(out)[0];
  if (a.args.path !== "a.txt" || a.args.offset !== 0 || a.args.arg_key) {
    throw new Error(JSON.stringify(a));
  }
});

check("<tool><tool_name>exec</tool_name> alternating tool_name dialect", () => {
  const text = `先装插件，再配频道。
<tool>
<tool_name>exec</tool_name>
<tool_name>command</tool_name>where openclaw 2>$null; Get-ChildItem -Path "E:\\openclaw-main" -Filter "openclaw*"
</tool_name>
<tool_name>yieldMs</tool_name>
<tool_name>5000</tool_name>
</tool>`;
  const out = normalizeCompletionPayload(payloadFromContent(text));
  const a = argsOf(out)[0];
  if (a?.name !== "exec") throw new Error(JSON.stringify(a));
  if (!String(a.args.command || "").includes("where openclaw")) {
    throw new Error(JSON.stringify(a.args));
  }
  if (String(a.args.yieldMs) !== "5000" && a.args.yieldMs !== 5000) {
    throw new Error(`yieldMs=${a.args.yieldMs}`);
  }
  const content = out.choices[0].message.content || "";
  if (/<tool>|tool_name|where openclaw/i.test(content)) {
    throw new Error(`leaked: ${content}`);
  }
  if (!content.includes("先装插件")) {
    throw new Error(`prose lost: ${content}`);
  }
});

check("root <web_search><query>…</query>", () => {
  const text = `搜一下。
<web_search>
<query>OpenClaw Feishu channel</query>
</web_search>`;
  const out = normalizeCompletionPayload(payloadFromContent(text));
  const a = argsOf(out)[0];
  if (a?.name !== "web_search" || a.args.query !== "OpenClaw Feishu channel") {
    throw new Error(JSON.stringify(a));
  }
  if (/web_search|<query>/i.test(out.choices[0].message.content || "")) {
    throw new Error(`leaked: ${out.choices[0].message.content}`);
  }
});

check("root <gateway><action>…</action>", () => {
  const text = `<gateway>
<action>config.get</action>
<path>channels.feishu</path>
</gateway>`;
  const out = normalizeCompletionPayload(payloadFromContent(text));
  const a = argsOf(out)[0];
  if (
    a?.name !== "gateway" ||
    a.args.action !== "config.get" ||
    a.args.path !== "channels.feishu"
  ) {
    throw new Error(JSON.stringify(a));
  }
});

check("root <read><path> bare body fallback", () => {
  const text = `<read>
E:\\ai_claw\\tool-ping.txt
</read>`;
  const extracted = extractToolCallsFromText(text);
  const args = JSON.parse(extracted.toolCalls[0].function.arguments);
  if (extracted.toolCalls[0].function.name !== "read") {
    throw new Error(JSON.stringify(extracted.toolCalls[0]));
  }
  if (args.path !== "E:\\ai_claw\\tool-ping.txt") {
    throw new Error(JSON.stringify(args));
  }
});

check("root <memory_search><query>", () => {
  const text = `<memory_search><query>feishu bot</query></memory_search>`;
  const out = normalizeCompletionPayload(payloadFromContent(text));
  const a = argsOf(out)[0];
  if (a?.name !== "memory_search" || a.args.query !== "feishu bot") {
    throw new Error(JSON.stringify(a));
  }
});

check("root <sessions_list> with inner args", () => {
  const text = `<sessions_list>
<limit>5</limit>
</sessions_list>`;
  const out = normalizeCompletionPayload(payloadFromContent(text));
  const a = argsOf(out)[0];
  if (a?.name !== "sessions_list" || String(a.args.limit) !== "5") {
    throw new Error(JSON.stringify(a));
  }
});

check("strip leaked tool: {ok,result} dump from assistant prose", () => {
  const text = `看到配置里有 channels.qqbot 选项，让我查一下具体需要哪些配置项。

tool: {
  "ok": true,
  "result": {
    "path": "channels.qqbot",
    "schema": { "type": "object", "title": "QQ Bot" }
  }
}`;
  const out = normalizeCompletionPayload(payloadFromContent(text));
  const content = out.choices[0].message.content || "";
  if (/\btool\s*:/i.test(content) || /"ok"\s*:\s*true/.test(content) || /"schema"\s*:/.test(content)) {
    throw new Error(`leaked tool result dump: ${content}`);
  }
  if (!content.includes("配置")) {
    throw new Error(`prose lost: ${content}`);
  }
  if (out.choices[0].message.tool_calls?.length) {
    throw new Error("should not invent tool_calls from a result dump");
  }
});

check("<tool_call>{\"read\":{...}} shorthand key=toolName", () => {
  const text = `<tool_call>
{"read": {"path": "E:\\\\openclaw-main\\\\docs\\\\channels\\\\qqbot.md"}}
</tool_call>
<tool_call>
{"read": {"path": "E:\\\\openclaw-main\\\\docs\\\\plugins\\\\reference\\\\qqbot.md"}}
</tool_call>`;
  const out = normalizeCompletionPayload(payloadFromContent(text));
  const calls = argsOf(out);
  if (calls?.length !== 2) throw new Error(`expected 2 calls, got ${JSON.stringify(calls)}`);
  if (calls[0].name !== "read" || !String(calls[0].args.path).includes("channels\\\\qqbot") && !String(calls[0].args.path).includes("channels\\qqbot") && !String(calls[0].args.path).includes("qqbot.md")) {
    throw new Error(JSON.stringify(calls[0]));
  }
  if (calls[1].name !== "read") throw new Error(JSON.stringify(calls[1]));
  if (out.choices[0].message.content) {
    throw new Error(`leaked content: ${out.choices[0].message.content}`);
  }
  if (out.choices[0].finish_reason !== "tool_calls") {
    throw new Error(`finish_reason=${out.choices[0].finish_reason}`);
  }
});

const failed = cases.filter((c) => !c.ok);
try {
  unlinkSync(modPath);
} catch {
  /* ignore */
}

if (failed.length) {
  console.error(`\n${failed.length}/${cases.length} failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} checks passed`);
