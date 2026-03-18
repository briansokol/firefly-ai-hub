import { Worker, NativeConnection } from '@temporalio/worker';
import { createActivities } from './activities.js';
import type { ActivityDeps } from './activities.js';

export async function createWorker(deps: ActivityDeps): Promise<Worker> {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const connection = await NativeConnection.connect({ address });

  return Worker.create({
    connection,
    namespace: 'default',
    taskQueue: 'firefly-ai-hub',
    workflowsPath: new URL('./workflows.js', import.meta.url).pathname,
    activities: createActivities(deps),
  });
}
