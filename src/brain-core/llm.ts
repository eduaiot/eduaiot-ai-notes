export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
}

export type Http = (request: HttpRequest) => Promise<HttpResponse>;

export class ModelError extends Error {}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  chat: string;
  embed: string;
  dimensions?: number;
  keyUrl: string;
  needsKey: boolean;
}

export const PROVIDERS: Provider[] = [
  { id: 'agnes', name: 'Agnes AI（免费）', baseUrl: 'https://api.agnes-ai.cn/v1', chat: 'agnes-3.0-flash', embed: '', keyUrl: 'https://platform.agnes-ai.cn/', needsKey: true },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', chat: 'deepseek-chat', embed: '', keyUrl: 'https://platform.deepseek.com/api_keys', needsKey: true },
  { id: 'qwen', name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chat: 'qwen-plus', embed: 'text-embedding-v4', dimensions: 1024, keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1', needsKey: true },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', chat: 'glm-4-flash', embed: 'embedding-3', dimensions: 1024, keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', needsKey: true },
  { id: 'moonshot', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', chat: 'moonshot-v1-32k', embed: '', keyUrl: 'https://platform.moonshot.cn/console/api-keys', needsKey: true },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', chat: 'deepseek-ai/DeepSeek-V3', embed: 'BAAI/bge-m3', keyUrl: 'https://cloud.siliconflow.cn/account/ak', needsKey: true },
  { id: 'ollama', name: 'Ollama（本机）', baseUrl: 'http://127.0.0.1:11434/v1', chat: 'qwen2.5:7b', embed: 'bge-m3', keyUrl: '', needsKey: false },
  { id: 'custom', name: '其他（兼容 OpenAI 接口）', baseUrl: '', chat: '', embed: '', keyUrl: '', needsKey: false }
];

const PRESET_MODELS: Record<string, { chat: string[]; embed: string[] }> = {
  deepseek: { chat: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'], embed: [] },
  qwen: { chat: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long', 'qwen-vl-max', 'qwen-vl-plus'], embed: ['text-embedding-v4', 'text-embedding-v3'] },
  zhipu: { chat: ['glm-4-flash', 'glm-4-plus', 'glm-4-air', 'glm-4-long', 'glm-4v-flash', 'glm-4v-plus'], embed: ['embedding-3'] },
  moonshot: { chat: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'], embed: [] },
  agnes: { chat: ['agnes-3.0-flash'], embed: [] },
  siliconflow: { chat: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'Qwen/Qwen2.5-VL-72B-Instruct'], embed: ['BAAI/bge-m3'] },
  ollama: { chat: ['qwen2.5:7b', 'qwen2.5vl:7b'], embed: ['bge-m3'] }
};

const EMBED_NAME = /embed|bge|m3e|gte|bce/i;

export function presetModels(id: string, kind: 'chat' | 'embed'): string[] {
  return PRESET_MODELS[id]?.[kind] ?? [];
}

export function modelsOfKind(names: string[], kind: 'chat' | 'embed'): string[] {
  return names.filter((name) => (kind === 'embed') === EMBED_NAME.test(name));
}

export async function listModels(http: Http, config: Pick<ModelConfig, 'baseUrl' | 'apiKey'>): Promise<string[]> {
  if (!config.baseUrl.trim()) return [];
  const headers: Record<string, string> = {};
  if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  const response = await http({ url: `${config.baseUrl.trim().replace(/\/+$/, '')}/models`, method: 'GET', headers });
  if (response.status >= 400) throw new ModelError(failure(response.status, null));
  const json = JSON.parse(response.text) as { data?: { id?: unknown }[]; models?: { name?: unknown }[] } | null;
  const ids = [...(json?.data ?? []).map((item) => item.id), ...(json?.models ?? []).map((item) => item.name)];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && Boolean(id)))].sort();
}

export function provider(id: string): Provider {
  return PROVIDERS.find((item) => item.id === id) ?? PROVIDERS[PROVIDERS.length - 1]!;
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

const VISION = /(deepseek-(v4-)?flash|vl\b|vl-|-vl|vision|\d+(\.\d+)?v\b|4o|gpt-4\.1|gpt-5|o3|o4|gemini|claude|omni|llava|minicpm-v|pixtral|internvl|qvq|glm-4\.\dv|kimi-k2\.5|kimi-latest|step-1o|doubao.*(vision|seed-1\.6))/i;

export function visionGuess(model: string): boolean {
  return VISION.test(model);
}

interface ErrorReply {
  error?: { message?: string };
  message?: string;
}

interface ChatReply {
  choices?: { finish_reason?: string; message?: { content?: unknown } }[];
}

interface EmbedReply {
  data?: { index?: number; embedding?: unknown }[];
}

function failure(status: number, json: unknown): string {
  const reply = json as ErrorReply | null;
  const detail = String(reply?.error?.message ?? reply?.message ?? '').slice(0, 200);
  const suffix = detail ? `：${detail}` : '';
  if (status === 401 || status === 403) return 'API Key 不对或没有权限，请在设置里检查';
  if (status === 402) return '模型账户余额不足';
  if (status === 429) return `请求太频繁或额度用完了，请稍后再试${suffix}`;
  if (status === 404) return `找不到这个模型，或接口地址不对${suffix}`;
  return `模型调用失败（${status}）${suffix}`;
}

async function post(http: Http, config: ModelConfig, path: string, body: object): Promise<unknown> {
  if (!config.baseUrl.trim()) throw new ModelError('还没有填写模型的接口地址');
  if (!config.model.trim()) throw new ModelError('还没有填写模型名称');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  let response: HttpResponse;
  try {
    response = await http({ url: `${config.baseUrl.trim().replace(/\/+$/, '')}${path}`, method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new ModelError('连不上模型服务，请检查网络和接口地址');
  }
  let json: unknown = null;
  try {
    json = JSON.parse(response.text) as unknown;
  } catch {
    json = null;
  }
  if (response.status >= 400) throw new ModelError(failure(response.status, json));
  if (!json) throw new ModelError('模型服务返回的内容无法识别');
  return json;
}

function rawImages(messages: Message[]): Message[] {
  return messages.map((item) => (typeof item.content === 'string' ? item : {
    ...item,
    content: item.content.map((part) => (part.type === 'image_url' ? { ...part, image_url: { url: part.image_url.url.replace(/^data:[^,]*,/, '') } } : part))
  }));
}

const THINKING_BUDGET = 16000;

export async function chat(http: Http, config: ModelConfig, messages: Message[], maxTokens = 2000): Promise<string> {
  const body = (tokens: number) => ({
    model: config.model.trim(),
    messages: /bigmodel\.cn/.test(config.baseUrl) ? rawImages(messages) : messages,
    temperature: 0.3,
    max_tokens: tokens,
    stream: false
  });
  let json = (await post(http, config, '/chat/completions', body(maxTokens))) as ChatReply;
  const empty = (reply: ChatReply) => {
    const text = reply.choices?.[0]?.message?.content;
    return typeof text !== 'string' || !text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  };
  if (empty(json) && json.choices?.[0]?.finish_reason === 'length' && maxTokens < THINKING_BUDGET) {
    json = (await post(http, config, '/chat/completions', body(THINKING_BUDGET))) as ChatReply;
  }
  const choice = json.choices?.[0];
  if (empty(json)) throw new ModelError(choice?.finish_reason === 'length' ? '模型思考太久，还没写出回答就到了长度上限。可以把问题说得具体些，或换一个模型' : '模型没有返回内容');
  return String(choice?.message?.content).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export async function embed(http: Http, config: ModelConfig, inputs: string[]): Promise<number[][]> {
  const json = (await post(http, config, '/embeddings', {
    model: config.model.trim(),
    input: inputs,
    ...(config.dimensions ? { dimensions: config.dimensions } : {})
  })) as EmbedReply;
  const data = json.data;
  if (!Array.isArray(data) || data.length !== inputs.length) throw new ModelError('按意思搜索的服务返回的数量不对');
  return [...data]
    .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
    .map((item) => {
      const vector = item?.embedding;
      if (!Array.isArray(vector) || !vector.length) throw new ModelError('按意思搜索的服务返回的内容无法识别');
      return vector as number[];
    });
}
