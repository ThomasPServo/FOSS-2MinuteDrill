// Runs web/js/engine/worker.js inside a Node worker thread with the small part of the Web
// Worker API it uses (self.onmessage / self.postMessage), so pool.js can be tested in Node.
import { parentPort, workerData } from 'node:worker_threads';

globalThis.self = globalThis;
globalThis.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer);
parentPort.on('message', (data) => globalThis.onmessage?.({ data }));
await import(workerData.url);
