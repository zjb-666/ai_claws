import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 5001);
const UPSTREAM = (process.env.JUYUAN_UPSTREAM || "http://192.168.120.213:5000").replace(
  /\/$/,
  "",
);
const MAX_RETRIES = Number(process.env.JUYUAN_PROXY_RETRIES || 3);
const RETRY_BASE_MS = Number(process.env.JUYUAN_PROXY_RETRY_MS || 400);

/** All tools the agent may emit as root XML tags. Keep broad — unknown dialects
 * should still convert or at least be stripped, never leak into chat bubbles. */
const KNOWN_TOOLS = new Set([
  "exec",
  "process",
  "read",
  "write",
  "edit",
  "apply_patch",
  "browser",
  "web_fetch",
  "web_search",
  "memory_search",
  "memory_get",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "session_status",
  "agents_list",
  "subagents",
  "cron",
  "gateway",
  "nodes",
  "message",
  "tts",
  "image",
  "image_generate",
  "music_generate",
  "video_generate",
  "pdf",
  "transcripts",
  "skill_workshop",
  "get_goal",
  "create_goal",
  "update_goal",
  "update_plan",
]);

const RESERVED_XML_TAGS = new Set([
  "tool_call",
  "tool_calls",
  "tool",
  "tools",
  "tool_name",
  "function",
  "functions",
  "args",
  "arguments",
  "parameters",
  "parameter",
  "arg_key",
  "arg_value",
  "think",
  "thinking",
  "reason",
  "reasoning",
  "div",
  "span",
  "p",
  "br",
  "a",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "table",
  "tr",
  "td",
  "th",
  "b",
  "i",
  "em",
  "strong",
]);

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultArgsForBareToolBody(toolName, body) {
  const text = String(body || "").trim();
  if (!text) return null;
  const t = String(toolName || "").toLowerCase();
  if (t === "exec" || t === "process") return { command: text };
  if (
    t === "read" ||
    t === "write" ||
    t === "edit" ||
    t === "apply_patch" ||
    t === "pdf" ||
    t === "image" ||
    t === "memory_get"
  ) {
    return { path: text };
  }
  if (t === "web_fetch") return { url: text };
  if (t === "web_search" || t === "memory_search") return { query: text };
  if (t === "message" || t === "tts") return { text };
  // Unknown: keep a single catch-all so promotion still happens; schema may
  // still reject, but XML will not leak into the user bubble.
  return { input: text };
}

function parseInnerXmlArgs(body) {
  const args = {};
  const innerRe = /<([a-zA-Z_][\w-]*)>\s*([\s\S]*?)\s*<\/\1>/gi;
  let im;
  while ((im = innerRe.exec(body))) {
    const key = im[1];
    if (RESERVED_XML_TAGS.has(key.toLowerCase()) && key.toLowerCase() !== "parameter") {
      continue;
    }
    if (key.toLowerCase() === "tool_name") continue;
    args[key] = im[2].trim();
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function takeJsonObjectAt(text, fromIndex = 0) {
  const start = text.indexOf("{", fromIndex);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        return { json: text.slice(start, i + 1), end: i + 1 };
      }
    }
  }
  return null;
}

/**
 * JuYuan compact calls with brace-balanced JSON extraction so a trailing
 * extra `}` from the model cannot poison JSON.parse.
 */
function extractCompactFunctionCalls(content, toolCalls) {
  const found = [];

  const scan = (re, requireToolCallClose) => {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(content))) {
      const name = match[1];
      const taken = takeJsonObjectAt(content, match.index + match[0].length);
      if (!taken) continue;
      let end = taken.end;
      // Models often emit one extra trailing `}` after a valid JSON object.
      while (content[end] === "}") end += 1;
      const tail = content.slice(end);
      const tailMatch = requireToolCallClose
        ? tail.match(/^\s*>?\s*(?:<\/function>\s*)?<\/tool_call>/)
        : tail.match(/^\s*>?\s*(?:<\/function>)?(?=\s*(?:<\/tool_call>|$))/);
      if (!tailMatch) continue;
      end += tailMatch[0].length;
      const args = safeJsonParse(taken.json) || {};
      const tc = toToolCall(name, args, toolCalls.length + found.length);
      if (!tc) continue;
      found.push({ start: match.index, end, tc });
    }
  };

  scan(
    /<tool_call>\s*<function=([A-Za-z0-9_.:-]+)\s*,\s*(?:parameters\s*=\s*)?/gi,
    true,
  );
  if (found.length === 0) {
    scan(
      /<function=([A-Za-z0-9_.:-]+)\s*,\s*(?:parameters\s*=\s*)?/gi,
      false,
    );
  }
  if (found.length === 0) return content;

  found.sort((a, b) => a.start - b.start);
  for (const f of found) toolCalls.push(f.tc);
  let cleaned = "";
  let cursor = 0;
  for (const f of found) {
    cleaned += content.slice(cursor, f.start);
    cursor = f.end;
  }
  cleaned += content.slice(cursor);
  return cleaned;
}

/**
 * Live dialect (seen 2026-08-07):
 * <tool>
 * <tool_name>exec</tool_name>
 * <tool_name>command</tool_name>powershell…</tool_name>
 * <tool_name>yieldMs</tool_name>
 * <tool_name>5000</tool_name>
 * </tool>
 *
 * Also accepts the cleaner form:
 * <tool><tool_name>exec</tool_name><command>…</command><yieldMs>5000</yieldMs></tool>
 */
function extractToolNameXmlBlocks(content, toolCalls) {
  const re = /<tool>\s*([\s\S]*?)<\/tool>/gi;
  return content.replace(re, (full, body) => {
    let rest = String(body || "").trim();
    const nameMatch = /^<tool_name>\s*([^<]+?)\s*<\/tool_name>\s*/i.exec(rest);
    if (!nameMatch) {
      // Fallback: <tool><name>exec</name>…
      const alt = /^<name>\s*([^<]+?)\s*<\/name>\s*/i.exec(rest);
      if (!alt) return full;
      rest = rest.slice(alt[0].length);
      const args = {};
      const innerRe = /<([a-zA-Z_][\w-]*)>\s*([\s\S]*?)\s*<\/\1>/gi;
      let im;
      while ((im = innerRe.exec(rest))) {
        if (im[1].toLowerCase() === "tool_name") continue;
        args[im[1]] = im[2].trim();
      }
      const tc = toToolCall(alt[1].trim(), args, toolCalls.length);
      if (!tc) return full;
      toolCalls.push(tc);
      return "";
    }

    const toolName = nameMatch[1].trim();
    rest = rest.slice(nameMatch[0].length);
    const args = {};

    while (rest.trim()) {
      // Proper arg tags: <command>…</command>
      const proper = /^<([a-zA-Z_][\w-]*)>\s*([\s\S]*?)\s*<\/\1>\s*/i.exec(rest);
      if (proper && proper[1].toLowerCase() !== "tool_name") {
        args[proper[1]] = proper[2].trim();
        rest = rest.slice(proper[0].length);
        continue;
      }

      const keyMatch = /^<tool_name>\s*([^<]+?)\s*<\/tool_name>\s*/i.exec(rest);
      if (!keyMatch) break;
      rest = rest.slice(keyMatch[0].length);
      const key = keyMatch[1].trim();
      if (!key) break;

      // Value in next <tool_name>…</tool_name>
      const valTag = /^<tool_name>\s*([^<]+?)\s*<\/tool_name>\s*/i.exec(rest);
      if (valTag) {
        args[key] = valTag[1].trim();
        rest = rest.slice(valTag[0].length);
        continue;
      }

      // Value as bare text until a closing </tool_name>
      const valText = /^([\s\S]*?)<\/tool_name>\s*/i.exec(rest);
      if (valText) {
        args[key] = valText[1].trim();
        rest = rest.slice(valText[0].length);
        continue;
      }
      break;
    }

    if (Object.keys(args).length === 0 && rest.trim()) {
      // Last resort: whole remainder is command for exec
      if (toolName.toLowerCase() === "exec") args.command = rest.trim();
    }

    const tc = toToolCall(toolName, args, toolCalls.length);
    if (!tc) return full;
    toolCalls.push(tc);
    return "";
  });
}

// Platform whitelist uses underscored ids (qwen3_6_plus). Gateway / UI may send
// dotted display names (qwen3.6-plus) which upstream rejects as model_not_allowed.
const MODEL_ALIASES = {
  "qwen3.6-plus": "qwen3_6_plus",
  "deepseek-v4-pro": "deepseek_v4_pro",
  glm_5: "glm_5",
  "glm-5": "glm_5",
};

function rewriteModelAliases(json) {
  if (!json || typeof json !== "object") return json;
  const raw = typeof json.model === "string" ? json.model.trim() : "";
  if (!raw) return json;
  const bare = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const mapped = MODEL_ALIASES[bare] || MODEL_ALIASES[raw];
  if (!mapped || mapped === bare) return json;
  json.model = mapped;
  if (process.env.JUYUAN_PROXY_LOG === "1") {
    console.log(`[proxy] model alias ${raw} → ${mapped}`);
  }
  return json;
}

function coerceArgValue(raw) {
  const text = typeof raw === "string" ? raw.trim() : raw;
  if (typeof text !== "string") return text;
  if (
    (text.startsWith("{") && text.endsWith("}")) ||
    (text.startsWith("[") && text.endsWith("]"))
  ) {
    const parsed = safeJsonParse(text);
    if (parsed !== null) return parsed;
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text) && !/^0\d+/.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  return text;
}

/**
 * JuYuan sometimes emits OpenAI tool_calls whose arguments are still the
 * XML pair shape: { "arg_key": "command", "arg_value": "…" } instead of
 * { "command": "…" }. Rewrite that (and stacked pairs) into real tool args.
 */
function rewriteArgKeyValueObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const keys = Object.keys(obj);
  if (keys.length === 0) return obj;

  // Single pair: { arg_key: "command", arg_value: "…" }
  if (
    "arg_key" in obj &&
    "arg_value" in obj &&
    typeof obj.arg_key === "string" &&
    obj.arg_key.trim()
  ) {
    const onlyMeta =
      keys.every((k) => k === "arg_key" || k === "arg_value") ||
      (keys.length === 2 && keys.includes("arg_key") && keys.includes("arg_value"));
    if (onlyMeta || !("command" in obj || "path" in obj || "url" in obj)) {
      const out = { ...obj };
      const k = String(obj.arg_key).trim();
      out[k] = coerceArgValue(obj.arg_value);
      delete out.arg_key;
      delete out.arg_value;
      return out;
    }
  }

  // Stacked: { arg_key: ["a","b"], arg_value: ["1","2"] }
  if (Array.isArray(obj.arg_key) && Array.isArray(obj.arg_value)) {
    const out = { ...obj };
    const n = Math.min(obj.arg_key.length, obj.arg_value.length);
    for (let i = 0; i < n; i++) {
      const k = String(obj.arg_key[i] ?? "").trim();
      if (!k) continue;
      out[k] = coerceArgValue(obj.arg_value[i]);
    }
    delete out.arg_key;
    delete out.arg_value;
    return out;
  }

  return obj;
}

function stripResidualToolXml(content) {
  if (!content || typeof content !== "string") return content;
  let cleaned = content;
  cleaned = cleaned.replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "");
  cleaned = cleaned.replace(/<tool>\s*[\s\S]*?<\/tool>/gi, "");
  // Any known tool root tag, including dialects we failed to promote.
  const toolAlt = [...KNOWN_TOOLS].map(escapeRegExp).join("|");
  if (toolAlt) {
    cleaned = cleaned.replace(
      new RegExp(`<(${toolAlt})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi"),
      "",
    );
  }
  cleaned = cleaned.replace(/<\/?tool_call\b[^>]*>/gi, "");
  cleaned = cleaned.replace(/<\/?tool_name\b[^>]*>/gi, "");
  cleaned = cleaned.replace(/<\/?function\b[^>]*>/gi, "");
  cleaned = cleaned.replace(/<function=[^>]*>[\s\S]*?(?:<\/function>|$)/gi, "");
  cleaned = cleaned.replace(/<arg_key>[\s\S]*?<\/arg_value>/gi, "");
  cleaned = cleaned.replace(/<\/?(?:arg_key|arg_value|parameter)\b[^>]*>/gi, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

/**
 * Models sometimes paste tool *results* into assistant prose, e.g.
 *   …配置项。\n\ntool: { "ok": true, "result": { ... } }
 * That ends the turn (stop) with a raw JSON dump. Strip those envelopes.
 */
function stripLeakedToolResultDumps(content) {
  if (!content || typeof content !== "string") return content;
  if (!/\btool\s*:/i.test(content) && !/"ok"\s*:/.test(content)) return content;

  let cleaned = content;
  const prefixRe =
    /(?:^|[\s\u3000。．.!！?？:：;；])(?:🛠️\s*)?(?:tool(?:\s*[-_]?\s*result)?|function(?:\s*[-_]?\s*result)?)\s*:\s*\{/gi;
  const ranges = [];
  let m;
  while ((m = prefixRe.exec(cleaned))) {
    const openBrace = m.index + m[0].length - 1;
    if (cleaned[openBrace] !== "{") continue;
    const taken = takeJsonObjectAt(cleaned, openBrace);
    if (!taken) continue;
    const obj = safeJsonParse(taken.json);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    if (!("ok" in obj)) continue;
    if (!("result" in obj || "error" in obj || "details" in obj)) continue;
    // Keep leading punctuation/whitespace from the prefix match.
    let start = m.index;
    const lead = m[0].match(/^[\s\u3000。．.!！?？:：;；]+/);
    if (lead) start += lead[0].length;
    ranges.push([start, taken.end]);
  }

  // Also strip a trailing bare {"ok":true,"result":...} when it is the last
  // JSON object in the message (common after a short Chinese preamble).
  const trailing = cleaned.match(/\{\s*"ok"\s*:/);
  if (trailing && ranges.length === 0) {
    const openBrace = trailing.index;
    const taken = takeJsonObjectAt(cleaned, openBrace);
    if (taken && taken.end >= cleaned.trimEnd().length) {
      const obj = safeJsonParse(taken.json);
      if (
        obj &&
        typeof obj === "object" &&
        !Array.isArray(obj) &&
        "ok" in obj &&
        ("result" in obj || "error" in obj)
      ) {
        // Only strip when the object dominates remaining text after a short prose head
        // or sits at the end after newlines.
        const before = cleaned.slice(0, openBrace).trimEnd();
        if (before.length === 0 || /\n\s*$/.test(cleaned.slice(0, openBrace))) {
          ranges.push([openBrace, taken.end]);
        }
      }
    }
  }

  if (ranges.length === 0) return content;
  ranges.sort((a, b) => b[0] - a[0]);
  for (const [start, end] of ranges) {
    cleaned = cleaned.slice(0, start) + cleaned.slice(end);
  }
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

function scrubAssistantContent(content) {
  if (!content || typeof content !== "string") return content;
  return stripLeakedToolResultDumps(stripResidualToolXml(content));
}

function normalizeNativeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return toolCalls;
  return toolCalls.map((tc, index) => {
    if (!tc || typeof tc !== "object") return tc;
    const fn = tc.function && typeof tc.function === "object" ? { ...tc.function } : null;
    if (!fn) return tc;
    let argsObj = {};
    if (typeof fn.arguments === "string") {
      const parsed = safeJsonParse(fn.arguments);
      argsObj =
        parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } else if (fn.arguments && typeof fn.arguments === "object") {
      argsObj = { ...fn.arguments };
    }
    argsObj = rewriteArgKeyValueObject(argsObj);
    const normalized = {};
    for (const [k, v] of Object.entries(argsObj)) {
      normalized[k] = coerceArgValue(v);
    }
    fn.arguments = JSON.stringify(normalized);
    return {
      ...tc,
      type: tc.type || "function",
      index: typeof tc.index === "number" ? tc.index : index,
      function: fn,
    };
  });
}

function toToolCall(name, args, index) {
  const toolName = String(name || "")
    .trim()
    .replace(/^[\"'`]+|[\"'`]+$/g, "");
  if (!toolName) return null;
  let argObj = args;
  if (typeof args === "string") {
    const parsed = safeJsonParse(args);
    argObj = parsed && typeof parsed === "object" ? parsed : { value: args };
  }
  if (argObj == null || typeof argObj !== "object" || Array.isArray(argObj))
    argObj = {};
  argObj = rewriteArgKeyValueObject(argObj);
  const normalized = {};
  for (const [k, v] of Object.entries(argObj)) {
    normalized[k] = coerceArgValue(v);
  }
  return {
    id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: {
      name: toolName,
      arguments: JSON.stringify(normalized),
    },
    index,
  };
}

function extractToolCallsFromText(content) {
  if (!content || typeof content !== "string") return null;
  const toolCalls = [];
  let cleaned = content;

  // JuYuan / Qwen style:
  // <tool_call>
  // <function=read>
  // <arg_key>path</arg_key>
  // <arg_value>...</arg_value>
  // </tool_call>
  const fnEqRe =
    /<tool_call>\s*<function=([^>\s]+)>\s*([\s\S]*?)<\/tool_call>/gi;
  cleaned = cleaned.replace(fnEqRe, (_full, name, body) => {
    const args = {};
    const pairRe =
      /<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi;
    let m;
    while ((m = pairRe.exec(body))) {
      args[m[1].trim()] = m[2].trim();
    }
    const paramRe =
      /<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/gi;
    while ((m = paramRe.exec(body))) {
      args[m[1].trim()] = m[2].trim();
    }
    const tc = toToolCall(name, args, toolCalls.length);
    if (tc) toolCalls.push(tc);
    return "";
  });

  // JuYuan compact: <function=name, {json}> / parameters={json} (brace-balanced)
  cleaned = extractCompactFunctionCalls(cleaned, toolCalls);

  // <tool><tool_name>exec</tool_name><tool_name>command</tool_name>…</tool_name>…
  cleaned = extractToolNameXmlBlocks(cleaned, toolCalls);

  // Bare JuYuan (no <tool_call> wrapper): <function=read><arg_key>…</arg_key>…
  if (toolCalls.length === 0) {
    const bareFnEqRe =
      /<function=([^>\s]+)>\s*((?:[\s\S]*?))(?=(?:<function=|<\/?tool_call\b|$))/gi;
    cleaned = cleaned.replace(bareFnEqRe, (full, name, body) => {
      const args = {};
      const pairRe =
        /<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi;
      let m;
      let found = false;
      while ((m = pairRe.exec(body))) {
        args[m[1].trim()] = m[2].trim();
        found = true;
      }
      const paramRe =
        /<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/gi;
      while ((m = paramRe.exec(body))) {
        args[m[1].trim()] = m[2].trim();
        found = true;
      }
      if (!found) return full;
      const tc = toToolCall(name, args, toolCalls.length);
      if (tc) toolCalls.push(tc);
      return "";
    });
  }

  // <tool_call>\n<tool>read(path="...")</tool>\n</tool_call>
  const toolFnCallRe =
    /<tool_call>\s*<tool>\s*([a-zA-Z_][\w-]*)\s*\(([\s\S]*?)\)\s*<\/tool>\s*(?:<\/tool_call>)?/gi;
  cleaned = cleaned.replace(toolFnCallRe, (_full, name, argPart) => {
    const args = {};
    const kvRe =
      /([a-zA-Z_][\w-]*)\s*=\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\{[\s\S]*\})|([^,\)]+))/g;
    let km;
    while ((km = kvRe.exec(argPart))) {
      args[km[1]] = (km[2] ?? km[3] ?? km[4] ?? km[5] ?? "").trim();
    }
    const tc = toToolCall(name, args, toolCalls.length);
    if (tc) toolCalls.push(tc);
    return "";
  });

  // Bare <tool>read(path="...")</tool>
  if (toolCalls.length === 0) {
    const bareToolFnRe =
      /<tool>\s*([a-zA-Z_][\w-]*)\s*\(([\s\S]*?)\)\s*<\/tool>/gi;
    cleaned = cleaned.replace(bareToolFnRe, (_full, name, argPart) => {
      const args = {};
      const kvRe =
        /([a-zA-Z_][\w-]*)\s*=\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\{[\s\S]*\})|([^,\)]+))/g;
      let km;
      while ((km = kvRe.exec(argPart))) {
        args[km[1]] = (km[2] ?? km[3] ?? km[4] ?? km[5] ?? "").trim();
      }
      const tc = toToolCall(name, args, toolCalls.length);
      if (tc) toolCalls.push(tc);
      return "";
    });
  }

  // <tool_call><tool><name>read</name><arg name="path">...</arg></tool></tool_call>
  const xmlToolRe =
    /<tool_call>\s*<tool>\s*<name>\s*([^<]+?)\s*<\/name>([\s\S]*?)<\/tool>\s*<\/tool_call>/gi;
  cleaned = cleaned.replace(xmlToolRe, (_full, name, body) => {
    const args = {};
    const argRe = /<arg\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/arg>/gi;
    let m;
    while ((m = argRe.exec(body))) {
      args[m[1]] = m[2].trim();
    }
    const paramRe =
      /<parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
    while ((m = paramRe.exec(body))) {
      args[m[1]] = m[2].trim();
    }
    const tc = toToolCall(name, args, toolCalls.length);
    if (tc) toolCalls.push(tc);
    return "";
  });

  // <tool_call>
  // <name>web_fetch
  // url: "https://..."
  // </tool_call>
  const nameYamlRe =
    /<tool_call>\s*<name>\s*([^\n<]+?)\s*\n([\s\S]*?)<\/tool_call>/gi;
  cleaned = cleaned.replace(nameYamlRe, (_full, name, body) => {
    const args = {};
    for (const line of String(body).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("<")) continue;
      const m = trimmed.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
      if (!m) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      const asNum = Number(value);
      args[m[1]] =
        Number.isFinite(asNum) && value !== "" && !/^0\d+/.test(value)
          ? asNum
          : value;
    }
    const tc = toToolCall(name.trim(), args, toolCalls.length);
    if (tc) toolCalls.push(tc);
    return "";
  });

  // <tool_call>{"name":"...","arguments":{...}}</tool_call>
  // also JuYuan shorthand: <tool_call>{"read": {"path": "..."}}</tool_call>
  // Must be brace-balanced — nested arg objects break non-greedy \{.*?\}.
  {
    const openRe = /<tool_call>\s*\{/gi;
    let om;
    const ranges = [];
    while ((om = openRe.exec(cleaned))) {
      const braceStart = om.index + om[0].length - 1;
      const taken = takeJsonObjectAt(cleaned, braceStart);
      if (!taken) continue;
      let end = taken.end;
      const close = cleaned.slice(end).match(/^\s*<\/tool_call>/i);
      if (close) end += close[0].length;
      ranges.push({ start: om.index, end, json: taken.json });
    }
    if (ranges.length > 0) {
      // Apply from the end so earlier indices stay valid.
      ranges.sort((a, b) => b.start - a.start);
      for (const range of ranges) {
        const obj = safeJsonParse(range.json);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          let name = obj.name || obj.tool;
          let args = obj.arguments ?? obj.args ?? obj.parameters;
          if (!name) {
            // Shorthand: single key is the tool name, value is args object/string.
            const keys = Object.keys(obj);
            if (keys.length === 1) {
              name = keys[0];
              args = obj[name];
            }
          }
          if (name) {
            const tc = toToolCall(
              name,
              args && typeof args === "object" ? args : args != null ? { value: args } : {},
              toolCalls.length,
            );
            if (tc) toolCalls.push(tc);
          }
        }
        cleaned = cleaned.slice(0, range.start) + cleaned.slice(range.end);
      }
    }
  }

  // Generic: ANY known tool as root XML tag embedded in prose
  //   <exec><command>…</command></exec>
  //   <web_search><query>…</query></web_search>
  //   <gateway><action>…</action></gateway>
  {
    const toolAlt = [...KNOWN_TOOLS].map(escapeRegExp).join("|");
    const rootToolRe = new RegExp(
      `<(${toolAlt})\\b[^>]*>\\s*([\\s\\S]*?)\\s*<\\/\\1>`,
      "gi",
    );
    cleaned = cleaned.replace(rootToolRe, (full, name, body) => {
      const toolName = String(name || "").toLowerCase();
      if (!KNOWN_TOOLS.has(toolName)) return full;
      let args = parseInnerXmlArgs(body);
      if (Object.keys(args).length === 0) {
        const bare = defaultArgsForBareToolBody(toolName, body);
        if (!bare) return full;
        args = bare;
      }
      const tc = toToolCall(toolName, args, toolCalls.length);
      if (tc) toolCalls.push(tc);
      return "";
    });
  }

  // Whole-message generic single-tool XML (unknown names allowed if not reserved)
  if (toolCalls.length === 0) {
    const genericRe =
      /^\s*<([a-zA-Z_][\w-]*)>\s*((?:<[a-zA-Z_][\w-]*>[\s\S]*?<\/[a-zA-Z_][\w-]*>\s*)+)\s*<\/\1>\s*$/;
    const gm = cleaned.match(genericRe);
    if (gm) {
      const name = gm[1];
      if (!RESERVED_XML_TAGS.has(name.toLowerCase())) {
        const args = parseInnerXmlArgs(gm[2]);
        if (Object.keys(args).length > 0) {
          const tc = toToolCall(name, args, 0);
          if (tc) {
            toolCalls.push(tc);
            cleaned = "";
          }
        }
      }
    }
  }

  // Malformed / truncated tool XML fallback
  if (toolCalls.length === 0 && /<tool_call\b/i.test(content)) {
    let name =
      content.match(/<name>\s*([^<\n]+?)\s*<\/name>/i)?.[1]?.trim() ||
      content.match(/<function=([^>\s]+)>/i)?.[1]?.trim() ||
      content.match(/<tool>\s*([a-zA-Z_][\w-]*)\s*\(/i)?.[1]?.trim() ||
      "";
    if (!name) {
      // Longer names first so image_generate wins over image.
      const toolsByLen = [...KNOWN_TOOLS].sort((a, b) => b.length - a.length);
      for (const tool of toolsByLen) {
        if (new RegExp(`\\b${escapeRegExp(tool)}\\b`, "i").test(content)) {
          name = tool;
          break;
        }
      }
    }
    const args = {};
    const brokenKeyRe =
      /<arg_key>\s*([a-zA-Z_][\w-]*)\s*["']?\s*>\s*([\s\S]*?)\s*<\/arg_key>/gi;
    let bm;
    while ((bm = brokenKeyRe.exec(content))) {
      args[bm[1]] = bm[2].trim();
    }
    const pairRe =
      /<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi;
    while ((bm = pairRe.exec(content))) {
      args[bm[1].trim()] = bm[2].trim();
    }
    if (!args.path) {
      const pathMatch =
        content.match(/\bpath\s*=\s*"([^"]+)"/i) ||
        content.match(/<path>\s*([^<]+?)\s*<\/path>/i) ||
        content.match(/\bpath["']?\s*>\s*([^<]+)/i);
      if (pathMatch) args.path = pathMatch[1].trim();
    }
    if (!args.url) {
      const urlMatch = content.match(/https?:\/\/[^\s<"']+/i);
      if (urlMatch) args.url = urlMatch[0];
    }
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      const m = trimmed.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
      if (!m) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(m[1] in args)) args[m[1]] = value;
    }
    if (name && Object.keys(args).length > 0) {
      const tc = toToolCall(name, args, 0);
      if (tc) {
        toolCalls.push(tc);
        cleaned = "";
      }
    }
  }

  if (toolCalls.length === 0) return null;
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return { toolCalls, cleanedContent: cleaned };
}

function normalizeCompletionPayload(payload) {
  if (!payload?.choices?.length) return payload;
  const choice = payload.choices[0];
  const message = choice?.message;
  if (!message) return payload;

  const content =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .map((p) => (typeof p === "string" ? p : p?.text || ""))
            .join("")
        : "";

  // Platform may already return tool_calls, but with JuYuan arg_key/arg_value
  // shape — still rewrite those, and always strip residual <tool_call> text.
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const normalizedCalls = normalizeNativeToolCalls(message.tool_calls).filter((tc) => {
      const args = safeJsonParse(tc.function?.arguments || "{}") || {};
      return Object.keys(args).length > 0;
    });
    if (normalizedCalls.length === 0) {
      delete message.tool_calls;
      return payload;
    }
    message.tool_calls = normalizedCalls;
    if (typeof message.content === "string") {
      const cleaned = scrubAssistantContent(message.content);
      // Keep original when strip would leave nothing and we still need a visible turn.
      if (cleaned) message.content = cleaned;
      else if (!message.content.trim()) message.content = null;
      else {
        // content was only tool XML — clear it now that real tool_calls exist
        message.content = null;
      }
    }
    if (!choice.finish_reason || choice.finish_reason === "stop") {
      choice.finish_reason = "tool_calls";
    }
    return payload;
  }

  const extracted = extractToolCallsFromText(content);
  if (!extracted) {
    if (typeof message.content === "string") {
      const hadDump = /\btool\s*:\s*\{/i.test(message.content);
      const hadXml = /<(?:tool_call|exec|function=)/i.test(message.content);
      const cleaned = scrubAssistantContent(message.content);
      if (cleaned) {
        message.content = cleaned;
      } else if (hadDump && !hadXml) {
        // Pure tool-result regurgitation — do not leave the JSON dump visible.
        message.content = null;
      }
      // Pure unparseable tool XML: keep original so core repair can still see it.
    }
    return payload;
  }

  const normalizedCalls = normalizeNativeToolCalls(extracted.toolCalls).filter((tc) => {
    const args = safeJsonParse(tc.function?.arguments || "{}") || {};
    return Object.keys(args).length > 0;
  });
  // Empty-arg "tools" only cause schema failures and wipe visible text — reject.
  if (normalizedCalls.length === 0) {
    if (typeof message.content === "string") {
      const cleaned = scrubAssistantContent(message.content);
      if (cleaned) message.content = cleaned;
    }
    return payload;
  }

  message.tool_calls = normalizedCalls;
  message.content = scrubAssistantContent(extracted.cleanedContent) || null;
  if (!choice.finish_reason || choice.finish_reason === "stop") {
    choice.finish_reason = "tool_calls";
  }
  return payload;
}

function writeSse(res, payload) {
  const id = payload.id || `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = payload.created || Math.floor(Date.now() / 1000);
  const model = payload.model || "qwen3_6_plus";
  const choice = payload.choices?.[0] || {};
  const message = choice.message || {};

  const roleChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

  if (message.content) {
    const contentChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: message.content },
          finish_reason: null,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
  }

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      const toolChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: tc.index ?? 0,
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.function?.name,
                    arguments: tc.function?.arguments || "",
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
    }
  }

  const finishReason =
    message.tool_calls?.length > 0
      ? "tool_calls"
      : choice.finish_reason || "stop";
  const finishChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    ...(payload.usage ? { usage: payload.usage } : {}),
  };
  res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
  res.write("data: [DONE]\n\n");
}

function buildUpstreamHeaders(req, bodyLen) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "content-length": String(bodyLen),
  };
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth) headers.authorization = auth;
  const apiKey = req.headers["x-api-key"];
  if (apiKey) headers["x-api-key"] = apiKey;
  return headers;
}

function shouldRetryStatus(status) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function fetchUpstreamWithRetry(upstreamUrl, method, headers, body) {
  let lastErr = null;
  let lastStatus = 0;
  let lastText = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const upstream = await fetch(upstreamUrl, {
        method,
        headers,
        body: body?.length ? body : undefined,
      });
      const text = await upstream.text();
      if (upstream.ok) {
        return { ok: true, status: upstream.status, text, contentType: upstream.headers.get("content-type") };
      }
      lastStatus = upstream.status;
      lastText = text;
      if (!shouldRetryStatus(upstream.status) || attempt === MAX_RETRIES) {
        return { ok: false, status: upstream.status, text, contentType: upstream.headers.get("content-type") };
      }
      const wait = RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(`[proxy] upstream ${upstream.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
      await sleep(wait);
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES) {
        return {
          ok: false,
          status: 502,
          text: JSON.stringify({
            error: {
              message: err instanceof Error ? err.message : String(err),
              upstream: upstreamUrl,
            },
          }),
          contentType: "application/json",
        };
      }
      const wait = RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(
        `[proxy] fetch failed (${err instanceof Error ? err.message : err}), retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`,
      );
      await sleep(wait);
    }
  }
  return {
    ok: false,
    status: lastStatus || 502,
    text:
      lastText ||
      JSON.stringify({
        error: {
          message: lastErr instanceof Error ? lastErr.message : "upstream unavailable",
        },
      }),
    contentType: "application/json",
  };
}

// Serialize chat completions so a burst of gateway retries cannot stampede
// the platform exit into immediate 503s.
let chatTail = Promise.resolve();
function enqueueChat(task) {
  const run = chatTail.then(task, task);
  chatTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    const upstreamUrl = `${UPSTREAM}${url.pathname}${url.search}`;
    const isChatCompletions = url.pathname.includes("/chat/completions");

    const handle = async () => {
      const bodyBuf = ["POST", "PUT", "PATCH"].includes(req.method || "")
        ? await readBody(req)
        : Buffer.alloc(0);

      let wantStream = false;
      let outboundBody = bodyBuf;
      if (
        bodyBuf.length &&
        (req.headers["content-type"] || "").includes("application/json")
      ) {
        try {
          const json = JSON.parse(bodyBuf.toString("utf8"));
          wantStream = json.stream === true;
          if (wantStream) {
            json.stream = false;
            delete json.stream_options;
          }
          rewriteModelAliases(json);
          outboundBody = Buffer.from(JSON.stringify(json), "utf8");
        } catch {
          // pass through raw body
        }
      }

      const headers = buildUpstreamHeaders(req, outboundBody.length);
      const result = await fetchUpstreamWithRetry(
        upstreamUrl,
        req.method,
        headers,
        outboundBody,
      );

      let payload = safeJsonParse(result.text);
      if (!payload) {
        if (!wantStream) {
          res.writeHead(result.status, {
            "content-type": result.contentType || "application/json",
          });
          res.end(result.text);
          return;
        }
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "upstream returned non-JSON",
              body: String(result.text).slice(0, 500),
            },
          }),
        );
        return;
      }

      if (!result.ok) {
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(result.text);
        return;
      }

      payload = normalizeCompletionPayload(payload);
      if (process.env.JUYUAN_PROXY_LOG === "1") {
        const m = payload?.choices?.[0]?.message;
        console.log(
          "[proxy]",
          "finish=",
          payload?.choices?.[0]?.finish_reason,
          "tools=",
          m?.tool_calls?.map((t) => t.function?.name).join(",") || "-",
          "content=",
          JSON.stringify(m?.content)?.slice(0, 160),
        );
      }

      if (!wantStream) {
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-cache",
        });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      writeSse(res, payload);
      res.end();
    };

    if (isChatCompletions) {
      await enqueueChat(handle);
    } else {
      await handle();
    }
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: error instanceof Error ? error.message : String(error) },
      }),
    );
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[juyuan-sse-proxy] listening on 0.0.0.0:${PORT} → ${UPSTREAM}`);
});
