import OpenAI from 'openai';
import { getSecrets } from '../env';

let _client: OpenAI | null = null;

/**
 * Singleton OpenAI client. Server-only.
 * Uses gpt-4o for function calling and financial context analysis.
 */
export function getOpenAIClient(): OpenAI {
  if (!_client) {
    const secrets = getSecrets();
    _client = new OpenAI({ apiKey: secrets.OPENAI_API_KEY });
  }
  return _client;
}

export const AI_MODEL = 'gpt-4o';
export const AI_MAX_TOKENS = 1024;
