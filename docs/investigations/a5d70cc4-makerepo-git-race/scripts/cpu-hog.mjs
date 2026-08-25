// Busy-loop CPU hog to saturate the host while the repro runs concurrently, mirroring
// the "15 CPU-saturating children" load condition from card 33aa0291's original observation.
const ms = Number(process.argv[2] || "60000");
const end = Date.now() + ms;
let x = 0;
while (Date.now() < end) {
  for (let i = 0; i < 1e6; i++) x += Math.sqrt(i) * Math.random();
}
console.log("done", x > -1);
