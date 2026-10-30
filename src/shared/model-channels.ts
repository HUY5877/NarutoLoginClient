export type ModelChannelId = 'openai' | 'deepseek' | 'yuwan';
export interface ModelChannel {
  id: ModelChannelId;
  name: string;
  model: string;
  enabled: boolean;
  version: string;
  configurationError?: string;
  keys: Array<{ id: string; masked: string }>;
}
export interface ModelChannelsResponse { environment: 'prod' | 'test'; channels: ModelChannel[] }
export type ModelChannelKeyInput = { id: string } | { value: string };
export interface ModelChannelUpdate { version: string; model: string; enabled: boolean; keys: ModelChannelKeyInput[] }
export interface ModelChannelTestResult { ok: boolean; latencyMs: number; message: string }
