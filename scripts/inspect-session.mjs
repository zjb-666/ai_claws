import fs from "node:fs";

const content = fs.readFileSync(process.argv[2] || "E:/ai_claw/scripts/sample-tool.txt", "utf8");
const key = "sk-jyc-CvWfg9un6HFvwn1KkJa6XnpLkBu_z8-ZOsL_ZpsujlQ";

// Force upstream-like content through proxy by asking model to echo — instead
// just validate by importing extract via dynamic eval of the proxy file helpers.
// Simpler: POST a stream:false request won't help. Run agent and inspect session.

const sessionGlob = process.argv[2];
if (!sessionGlob) {
  console.log("usage: node inspect-session.mjs <session.jsonl>");
  process.exit(1);
}
const lines = fs.readFileSync(sessionGlob, "utf8").trim().split(/\n+/);
for (const line of lines.slice(-8)) {
  const o = JSON.parse(line);
  const msg = o.message || o;
  const role = msg.role || o.type;
  let c = msg.content ?? "";
  if (Array.isArray(c)) c = JSON.stringify(c);
  console.log("---", role, String(c).slice(0, 400));
}
