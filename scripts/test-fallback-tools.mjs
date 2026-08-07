const samples = [
  `<tool_call>
<tool>
<name>read</name>
<arg_key>path">E:\\openclaw-main\\skills\\weather\\SKILL.md</arg_key>
</tool>`,
  `<tool_call>
<name>web_fetch
url: "https://wttr.in/Beijing?format=j2"
extractMode: "text"
maxChars: 12000
</tool_call>`,
  `<read>
<path>E:\\openclaw-main\\skills\\weather\\SKILL.md</path>
</read>`,
];

// Import by spawning proxy normalize — duplicate minimal call via dynamic import of file won't export.
// Instead paste a require of extract by evaluating after reading the file is heavy.
// Call the running proxy? Can't inject content.
// Just regex-check the fallback pieces:

for (const content of samples) {
  let name =
    content.match(/<name>\s*([^<\n]+?)\s*<\/name>/i)?.[1]?.trim() ||
    content.match(/<name>\s*([^\n<]+?)\s*\n/i)?.[1]?.trim() ||
    content.match(/<function=([^>\s]+)>/i)?.[1]?.trim() ||
    "";
  if (!name) {
    const g = content.match(/^\s*<([a-zA-Z_][\w-]*)>/);
    name = g?.[1] || "";
  }
  const args = {};
  const brokenKeyRe =
    /<arg_key>\s*([a-zA-Z_][\w-]*)\s*["']?\s*>\s*([\s\S]*?)\s*<\/arg_key>/gi;
  let bm;
  while ((bm = brokenKeyRe.exec(content))) args[bm[1]] = bm[2].trim();
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(m[1] in args)) args[m[1]] = value;
  }
  console.log({ name, args });
}
