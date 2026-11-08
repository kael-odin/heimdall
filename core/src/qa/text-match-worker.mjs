import { parentPort, workerData } from 'node:worker_threads';

const expression = new RegExp(workerData.pattern);
const failed = [];
for (let i = 0; i < workerData.values.length; i++) {
  if (!expression.test(workerData.values[i])) failed.push(i);
}
parentPort.postMessage(failed);
