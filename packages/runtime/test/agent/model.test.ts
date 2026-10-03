import { describe, expect, it } from 'vitest';
import { ChatBedrockConverse } from '@langchain/aws';
import { ChatOpenAI } from '@langchain/openai';
import { createChatModel } from '../../src/agent/model.js';

describe('createChatModel', () => {
  it('creates a Bedrock Converse model by default provider', () => {
    const m = createChatModel({ provider: 'bedrock', modelId: 'amazon.nova-lite-v1:0', region: 'eu-west-1' });
    expect(m).toBeInstanceOf(ChatBedrockConverse);
    expect((m as ChatBedrockConverse).model).toBe('amazon.nova-lite-v1:0');
  });

  it('creates an OpenAI-compatible model pointed at a custom base URL', () => {
    const m = createChatModel({ provider: 'openai-compatible', modelId: 'llama3.1', baseUrl: 'http://localhost:11434/v1' });
    expect(m).toBeInstanceOf(ChatOpenAI);
    expect((m as ChatOpenAI).model).toBe('llama3.1');
  });

  it('rejects unknown providers', () => {
    expect(() => createChatModel({ provider: 'nope' as never, modelId: 'x' })).toThrow(/provider/);
  });
});
