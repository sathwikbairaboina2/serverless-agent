import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatBedrockConverse } from '@langchain/aws';
import { ChatOpenAI } from '@langchain/openai';
import type { ModelConfig } from '../config.js';

export function createChatModel(cfg: ModelConfig & { apiKey?: string }): BaseChatModel {
  switch (cfg.provider) {
    case 'bedrock':
      return new ChatBedrockConverse({ model: cfg.modelId, region: cfg.region ?? 'us-east-1' });
    case 'openai-compatible':
      return new ChatOpenAI({ model: cfg.modelId, apiKey: cfg.apiKey ?? 'not-needed', configuration: { baseURL: cfg.baseUrl } });
    default:
      throw new Error(`Unknown model provider "${(cfg as { provider: string }).provider}"`);
  }
}
