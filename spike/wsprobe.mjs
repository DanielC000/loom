// Headless ws probe for demo #6: attach to a session, capture frames for N ms,
// report coherence signals. Usage: node wsprobe.mjs <loomId> <ms>
import { WebSocket } from "ws";
const [id, ms] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:7878/ws/term/${id}`);
ws.binaryType = "arraybuffer";
let bin = 0, binBytes = 0; const ctrl = []; const chunks = [];
ws.on("message", (data, isBinary) => {
  if (isBinary) { bin++; binBytes += data.length; chunks.push(Buffer.from(data)); }
  else ctrl.push(data.toString());
});
ws.on("error", (e) => { console.log(JSON.stringify({ error: String(e) })); process.exit(1); });
setTimeout(() => {
  const all = Buffer.concat(chunks);
  const txt = all.toString("latin1");
  const clears = (txt.match(/\x1b\[2J/g) || []).length;
  const lastClear = txt.lastIndexOf("\x1b[2J");
  console.log(JSON.stringify({
    binFrames: bin, binBytes, ctrl, fullRepaintsInReplay: clears,
    bytesAfterLastRepaint: lastClear >= 0 ? all.length - lastClear : -1,
    tail: txt.slice(-160).replace(/[^\x20-\x7e]/g, "."),
  }));
  ws.close(); process.exit(0);
}, Number(ms) || 2500);
