import type { ModelChannel, ModelChannelsResponse, ModelChannelTestResult } from '../../shared/model-channels';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function isModelChannel(value: unknown): value is ModelChannel {
  return object(value) && ['openai', 'deepseek', 'yuwan'].includes(String(value.id))
    && typeof value.version === 'string' && value.version.length > 0
    && (value.configurationError === undefined || typeof value.configurationError === 'string')
    && typeof value.name === 'string' && typeof value.model === 'string' && [...value.model].length <= 200
    && typeof value.enabled === 'boolean' && Array.isArray(value.keys) && value.keys.length <= 20
    && value.keys.every(key => object(key) && typeof key.id === 'string' && key.id.length > 0 && typeof key.masked === 'string')
    && new Set(value.keys.map(key => (key as { id: string }).id)).size === value.keys.length;
}

export function isModelChannelsResponse(value: unknown): value is ModelChannelsResponse {
  return object(value) && ['prod', 'test'].includes(String(value.environment)) && Array.isArray(value.channels)
    && value.channels.length === 3 && value.channels.every(isModelChannel)
    && new Set(value.channels.map(channel => channel.id)).size === 3;
}

export function isModelChannelTestResult(value: unknown): value is ModelChannelTestResult {
  return object(value) && typeof value.ok === 'boolean' && typeof value.latencyMs === 'number'
    && Number.isFinite(value.latencyMs) && value.latencyMs >= 0 && typeof value.message === 'string';
}
