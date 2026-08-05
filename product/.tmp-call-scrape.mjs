const PORT = Number(process.env.CDP_PORT || 59333);
const TARGET = "\u90b9\u5bb6\u5175";

async function list() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
}

function make(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", (event) => reject(event.error || event));
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id == null || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  });
  async function call(method, params = {}, timeoutMs = 240000) {
    await ready;
    const mid = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(mid);
        reject(new Error(`timeout ${method}`));
      }, timeoutMs);
      pending.set(mid, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }
  return { call, ws, ready };
}

async function evaluate(cdp, expression, timeoutMs = 240000) {
  const result = await cdp.call(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    timeoutMs,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails?.exception?.description || JSON.stringify(result.exceptionDetails),
    );
  }
  return result.result?.value;
}

const targets = await list();
const app = targets.find((target) => /8787/.test(target.url || ""));
if (!app) throw new Error("no app page");
const cdp = make(app.webSocketDebuggerUrl);
await cdp.ready;
await cdp.call("Runtime.enable");

const result = await evaluate(
  cdp,
  `(async () => {
    const scrape = await window.desktopApp.boss.scrapeInbox({
      limit: 150,
      todayOnly: false,
      jobTitle: "AI 开发",
      headcount: 3,
    });
    const hit = (scrape?.candidates || []).find((candidate) => candidate.name === ${JSON.stringify(TARGET)});
    return {
      scrape: {
        ok: scrape?.ok,
        loggedIn: scrape?.loggedIn,
        blocked: scrape?.blocked,
        count: scrape?.candidates?.length || 0,
        message: scrape?.message,
        target: hit || null,
        candidates: scrape?.candidates || [],
        names: (scrape?.candidates || []).slice(0, 20).map((candidate) => candidate.name),
      },
    };
  })()`,
);
console.log(JSON.stringify(result, null, 2));
cdp.ws.close();
