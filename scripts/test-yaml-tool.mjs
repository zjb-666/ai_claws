const content = `<tool_call>
<name>web_fetch
url: "https://wttr.in/Beijing?format=j2"
extractMode: "text"
maxChars: 12000
</tool_call>`;
const nameYamlRe = /<tool_call>\s*<name>\s*([^\n<]+?)\s*\n([\s\S]*?)<\/tool_call>/gi;
const m = nameYamlRe.exec(content);
console.log('name', m?.[1]);
console.log('body', m?.[2]);
const args = {};
for (const line of String(m[2]).split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("<")) continue;
  const km = trimmed.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
  if (!km) continue;
  let value = km[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1,-1);
  const asNum = Number(value);
  args[km[1]] = Number.isFinite(asNum) && value !== "" && !/^0\d+/.test(value) ? asNum : value;
}
console.log('args', args);
