import { describe, expect, it } from 'vitest';
import * as runtime from '../src/index.js';
import * as handlers from '../src/handlers/index.js';

describe('runtime public surface', () => {
  it('exports the checkpointer, graph builder and handler factories', () => {
    for (const name of ['DynamoDBSaver', 'buildAgentGraph', 'demoTools', 'createChatModel', 'createAgentStepHandler', 'createRequestApprovalHandler', 'createApprovalCallbackHandler', 'createWebSocketHandler', 'ApiGatewayNotifier', 'TokenBatcher', 'estimateCostUsd', 'buildEmfRecord']) {
      expect(runtime, name).toHaveProperty(name);
    }
  });

  it('exposes four lazily configured Lambda entrypoints that import without env vars', () => {
    expect(Object.keys(handlers).sort()).toEqual(['agentStep', 'approvalCallback', 'requestApproval', 'wsHandler']);
    for (const fn of Object.values(handlers)) expect(typeof fn).toBe('function');
  });

  it('fails clearly on first invocation when configuration is missing', async () => {
    const before = process.env.STATE_MACHINE_ARN;
    delete process.env.STATE_MACHINE_ARN;
    await expect(handlers.wsHandler({ requestContext: { routeKey: '$default', connectionId: 'c' }, body: '{}' } as never)).rejects.toThrow('Missing required environment variable STATE_MACHINE_ARN');
    if (before !== undefined) process.env.STATE_MACHINE_ARN = before;
  });
});
