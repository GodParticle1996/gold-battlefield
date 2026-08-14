import type { WorkerInMessage } from './types';

// App ↔ worker bridge so any component can send control messages without
// threading refs through props.
let worker: Worker | null = null;

export function setWorker(w: Worker | null): void {
  worker = w;
}

export function sendWorker(message: WorkerInMessage): void {
  worker?.postMessage(message);
}
