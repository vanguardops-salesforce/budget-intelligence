/**
 * OpenAI client initialization. Server-only singleton.
 */

import OpenAI from 'openai';
import { getSecrets } from '../env';

let _client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (typeof window !== 'undefined') {
    throw new Error('CRITICAL: getOpenAIClient() called in browser context.');
  }
  if (!_client) {
    const secrets = getSecrets();
    _client = new OpenAI({ apiKey: secrets.OPENAI_API_KEY });
  }
  return _client;
}
