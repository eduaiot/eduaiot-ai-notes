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
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', chat: 'deepseek-chat', embed: '', keyUrl: 'https://platform.deepseek.com/api_keys', needsKey: true },
  { id: 'qwen', name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chat: 'qwen-plus', embed: 'text-embedding-v4', dimensions: 1024, keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1', needsKey: true },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', chat: 'glm-4-flash', embed: 'embedding-3', dimensions: 1024, keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', needsKey: true },
  { id: 'moonshot', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', chat: 'moonshot-v1-32k', embed: '', keyUrl: 'https://platform.moonshot.cn/console/api-keys', needsKey: true },
  { id: 'agnes', name: 'Agnes AI', baseUrl: 'https://api.agnes-ai.cn/v1', chat: 'agnes-3.0-flash', embed: '', keyUrl: 'https://platform.agnes-ai.cn/', needsKey: true },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', chat: 'deepseek-ai/DeepSeek-V3', embed: 'BAAI/bge-m3', keyUrl: 'https://cloud.siliconflow.cn/account/ak', needsKey: true },
  { id: 'ollama', name: 'Ollama（本机）', baseUrl: 'http://127.0.0.1:11434/v1', chat: 'qwen2.5:7b', embed: 'bge-m3', keyUrl: '', needsKey: false },
  { id: 'custom', name: '其他（兼容 OpenAI 接口）', baseUrl: '', chat: '', embed: '', keyUrl: '', needsKey: false }
];

export function provider(id: string): Provider {
  return PROVIDERS.find((item) => item.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function failure(status: number, json: any): string {
  const detail = String(json?.error?.message ?? json?.message ?? '').slice(0, 200);
  const suffix = detail ? `：${detail}` : '';
  if (status === 401 || status === 403) return 'API Key 不对或没有权限，请在设置里检查';
  if (status === 402) return '模型账户余额不足';
  if (status === 429) return `请求太频繁或额度用完了，请稍后再试${suffix}`;
  if (status === 404) return `找不到这个模型，或接口地址不对${suffix}`;
  return `模型调用失败（${status}）${suffix}`;
}

async function post(http: Http, config: ModelConfig, path: string, body: object): Promise<any> {
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
  let json: any = null;
  try {
    json = JSON.parse(response.text);
  } catch {
    json = null;
  }
  if (response.status >= 400) throw new ModelError(failure(response.status, json));
  if (!json) throw new ModelError('模型服务返回的内容无法识别');
  return json;
}

export async function chat(http: Http, config: ModelConfig, messages: Message[], maxTokens = 2000): Promise<string> {
  const json = await post(http, config, '/chat/completions', {
    model: config.model.trim(),
    messages,
    temperature: 0.3,
    max_tokens: maxTokens,
    stream: false
  });
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new ModelError('模型没有返回内容');
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export async function embed(http: Http, config: ModelConfig, inputs: string[]): Promise<number[][]> {
  const json = await post(http, config, '/embeddings', {
    model: config.model.trim(),
    input: inputs,
    ...(config.dimensions ? { dimensions: config.dimensions } : {})
  });
  const data = json?.data;
  if (!Array.isArray(data) || data.length !== inputs.length) throw new ModelError('向量模型返回的数量不对');
  return [...data]
    .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
    .map((item) => {
      if (!Array.isArray(item?.embedding) || !item.embedding.length) throw new ModelError('向量模型返回的内容无法识别');
      return item.embedding as number[];
    });
}
