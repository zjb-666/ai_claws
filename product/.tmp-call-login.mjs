const PORT = Number(process.env.CDP_PORT || 59337);
async function list() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
}
function make(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", (e) => rej(e.error || e));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  });
  async function call(method, params = {}, timeoutMs = 30000) {
    await ready;
    const mid = ++id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(mid);
        reject(new Error("timeout " + method));
      }, timeoutMs);
      pending.set(mid, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }
  return { call, ws, ready };
}
async function ev(cdp, expression, timeoutMs = 30000) {
  const r = await cdp.call(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    timeoutMs,
  );
  if (r.exceptionDetails)
    throw new Error(
      r.exceptionDetails?.exception?.description || JSON.stringify(r.exceptionDetails),
    );
  return r.result?.value;
}
const targets = await list();
const app = targets.find((t) => /8787/.test(t.url || ""));
if (!app) throw new Error("no app page");
const cdp = make(app.webSocketDebuggerUrl);
await cdp.ready;
await cdp.call("Runtime.enable");
console.log(JSON.stringify(await ev(cdp, `window.desktopApp.boss.checkLogin()`, 30000), null, 2));
cdp.ws.close();
