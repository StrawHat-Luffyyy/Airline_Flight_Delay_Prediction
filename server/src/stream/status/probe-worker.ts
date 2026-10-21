/**
 * The Kafka probe process (see isolated-probe.ts): answers `{id}` requests over IPC with a snapshot
 * from the in-process probe, and exits when the parent closes the channel. Started by the API with
 * fork(); never run directly.
 */
import { createInProcessProbe } from '../kafka.js';
import { ProbeRequestSchema } from './isolated-probe.js';

const probe = createInProcessProbe();

process.on('message', (message: unknown) => {
  const request = ProbeRequestSchema.safeParse(message);
  if (!request.success) return;
  // read() never rejects: failures come back as an unreachable snapshot.
  void probe.read().then((snapshot) => process.send?.({ id: request.data.id, snapshot }));
});

process.on('disconnect', () => {
  void probe.close().finally(() => process.exit(0));
});
