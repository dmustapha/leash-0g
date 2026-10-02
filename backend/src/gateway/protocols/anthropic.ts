import type { Json } from '../../crypto/canonical.js';

/**
 * SF-1 / BR-F1 — the Anthropic Messages API ⇄ OpenAI chat-completions adapter.
 *
 * SD-F4: this is a protocol ADAPTER onto the 0G-Compute OpenAI backend, NOT an
 * external-provider proxy — an Anthropic-shaped request is mapped to the exact
 * OpenAI body the existing gateway already governs + forwards, and the OpenAI
 * response is mapped back to the Anthropic shape. Interception parity (F-1a) is
 * structural: the EXISTING `evaluateRules` pipeline runs on the mapped OpenAI
 * body, so observe/block/modify/require_approval apply identically — including
 * on `tool_use`/`tool_result` content (their text rides into `tool_calls`
 * arguments / `role:'tool'` message content, which the serialized-body backstop
 * in `interceptor.ts` scans).
 *
 * Streaming is NOT translated in v1 (`stream:true` is refused upstream of this
 * module): Anthropic's event-framed SSE differs structurally from OpenAI chunks
 * and in-flight intervention on a stream is documented-weaker (`00 §5b`). The
 * honest, fail-closed choice is to refuse rather than overclaim parity.
 */

export interface AdaptOk {
  ok: true;
  openai: Record<string, Json>;
}
export interface AdaptErr {
  ok: false;
  reason: string;
}
export type AdaptResult = AdaptOk | AdaptErr;

const FINISH_TO_STOP: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn',
};

/**
 * Anthropic Messages request → OpenAI chat-completions body. Assumes the body
 * already passed `isAnthropicRequestShape` (exact-shape gate, F-1c); the only
 * residual failure here is a structurally-impossible block (e.g. an image with
 * an unsupported source), which fails CLOSED with a reason.
 */
export function anthropicToOpenAI(body: Record<string, Json>): AdaptResult {
  // Defense-in-depth: callers adapt only after `isAnthropicRequestShape`, but
  // the mapper is TOTAL — hostile/degenerate input fails closed, never crashes.
  if (!isObject(body) || !Array.isArray(body['messages'])) {
    return { ok: false, reason: 'not an Anthropic Messages body' };
  }
  const openaiMessages: Json[] = [];

  const systemText = hoistSystem(body['system']);
  if (systemText !== null) openaiMessages.push({ role: 'system', content: systemText });

  const messages = body['messages'];
  for (const raw of messages) {
    const m = raw as Record<string, Json>;
    const role = m['role'] as 'user' | 'assistant';
    const mapped = mapMessage(role, m['content']);
    if (!mapped.ok) return mapped;
    openaiMessages.push(...mapped.messages);
  }

  const openai: Record<string, Json> = {
    model: body['model'] as string,
    max_tokens: body['max_tokens'] as number,
    messages: openaiMessages,
  };

  copyIfNumber(openai, body, 'temperature');
  copyIfNumber(openai, body, 'top_p');
  if (Array.isArray(body['stop_sequences'])) openai['stop'] = body['stop_sequences'];
  const tools = mapTools(body['tools']);
  if (tools) openai['tools'] = tools;
  const toolChoice = mapToolChoice(body['tool_choice']);
  if (toolChoice !== undefined) openai['tool_choice'] = toolChoice;

  return { ok: true, openai };
}

function hoistSystem(system: Json | undefined): string | null {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (b && typeof b === 'object' && !Array.isArray(b) ? (b['text'] as string) ?? '' : ''))
      .join('');
  }
  return null;
}

interface MappedMessages {
  ok: true;
  messages: Json[];
}
function mapMessage(role: 'user' | 'assistant', content: Json | undefined): MappedMessages | AdaptErr {
  if (typeof content === 'string') return { ok: true, messages: [{ role, content }] };
  if (!Array.isArray(content)) return { ok: false, reason: 'message content must be string or block array' };

  // tool_result blocks become standalone OpenAI `role:'tool'` messages and must
  // precede the residual user text (OpenAI requires tool replies to follow the
  // assistant tool_calls they answer). Collect each stream separately.
  const toolMessages: Json[] = [];
  const textParts: Json[] = [];
  const toolCalls: Json[] = [];

  for (const block of content) {
    const b = block as Record<string, Json>;
    switch (b['type']) {
      case 'text':
        textParts.push({ type: 'text', text: str(b['text']) });
        break;
      case 'image': {
        const img = mapImage(b);
        if (!img.ok) return img;
        textParts.push(img.part);
        break;
      }
      case 'tool_use':
        toolCalls.push({
          id: str(b['id']),
          type: 'function',
          function: { name: str(b['name']), arguments: JSON.stringify(b['input'] ?? {}) },
        });
        break;
      case 'tool_result':
        toolMessages.push({
          role: 'tool',
          tool_call_id: str(b['tool_use_id']),
          content: toolResultText(b['content']),
        });
        break;
      default:
        return { ok: false, reason: `unknown content block type` };
    }
  }

  const out: Json[] = [...toolMessages];
  // Emit tool_calls whenever present, REGARDLESS of role (SEC parity): a
  // tool_use block on a (malformed) user message must not silently drop its
  // payload — the needle has to ride into the mapped body the interceptor
  // scans. Empty text + tool_calls uses '' content (not []), the OpenAI-canonical
  // shape some strict backends require.
  if (toolCalls.length > 0) {
    out.push({ role, content: textParts.length > 0 ? collapseText(textParts) : '', tool_calls: toolCalls });
  } else if (textParts.length > 0) {
    out.push({ role, content: collapseText(textParts) });
  } else if (toolMessages.length === 0) {
    out.push({ role, content: '' });
  }
  return { ok: true, messages: out };
}

/** A single text part collapses to a plain string (OpenAI-canonical); mixed/multi stays an array. */
function collapseText(parts: Json[]): Json {
  if (parts.length === 1 && isObject(parts[0]) && parts[0]['type'] === 'text') return parts[0]['text'] as string;
  return parts;
}

/**
 * Collapse a `tool_result.content` to the OpenAI tool-message content string.
 * LOSSLESS over attacker-influenceable text (SEC H-01 / F-1a parity): a text
 * sub-block contributes its text; any NON-text sub-block is serialized verbatim
 * so its payload still rides into the mapped body the interceptor scans — a
 * needle can never be silently dropped during mapping. Shape validity of the
 * sub-blocks is enforced upstream by `isValidAnthropicContent` (fail-closed).
 */
function toolResultText(content: Json | undefined): Json {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isObject(b) && b['type'] === 'text' ? str(b['text']) : JSON.stringify(b)))
      .join('');
  }
  if (content === undefined) return '';
  return JSON.stringify(content);
}

interface MappedImage {
  ok: true;
  part: Json;
}
function mapImage(b: Record<string, Json>): MappedImage | AdaptErr {
  const source = b['source'];
  if (!isObject(source)) return { ok: false, reason: 'image block missing source' };
  if (source['type'] === 'base64' && typeof source['media_type'] === 'string' && typeof source['data'] === 'string') {
    return { ok: true, part: { type: 'image_url', image_url: { url: `data:${source['media_type']};base64,${source['data']}` } } };
  }
  if (source['type'] === 'url' && typeof source['url'] === 'string') {
    return { ok: true, part: { type: 'image_url', image_url: { url: source['url'] } } };
  }
  return { ok: false, reason: 'unsupported image source' };
}

function mapTools(tools: Json | undefined): Json | null {
  if (!Array.isArray(tools)) return null;
  return tools.map((t) => {
    const tool = t as Record<string, Json>;
    return {
      type: 'function',
      function: {
        name: (tool['name'] as string) ?? '',
        ...(typeof tool['description'] === 'string' ? { description: tool['description'] } : {}),
        parameters: tool['input_schema'] ?? {},
      },
    };
  });
}

function mapToolChoice(choice: Json | undefined): Json | undefined {
  if (!isObject(choice)) return undefined;
  switch (choice['type']) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'tool':
      return { type: 'function', function: { name: str(choice['name']) } };
    default:
      return undefined;
  }
}

/**
 * OpenAI chat-completions response → Anthropic Messages response. `reqModel` is
 * echoed when the backend omits a model. Unparseable `tool_calls.arguments`
 * fail safe to an empty `input` (never crash the mapping on malformed upstream).
 */
export function openAIToAnthropic(openaiResp: Json, reqModel: string): Record<string, Json> {
  const resp = isObject(openaiResp) ? openaiResp : {};
  const choice = Array.isArray(resp['choices']) && isObject(resp['choices'][0]) ? resp['choices'][0] : {};
  const message = isObject(choice['message']) ? choice['message'] : {};
  const content: Json[] = [];

  if (typeof message['content'] === 'string' && message['content'].length > 0) {
    content.push({ type: 'text', text: message['content'] });
  }
  if (Array.isArray(message['tool_calls'])) {
    for (const tc of message['tool_calls']) {
      if (!isObject(tc)) continue;
      const fn = isObject(tc['function']) ? tc['function'] : {};
      content.push({
        type: 'tool_use',
        id: str(tc['id']),
        name: str(fn['name']),
        input: parseArgs(fn['arguments']),
      });
    }
  }

  const usage = isObject(resp['usage']) ? resp['usage'] : {};
  return {
    id: typeof resp['id'] === 'string' ? resp['id'] : 'msg_unknown',
    type: 'message',
    role: 'assistant',
    model: typeof resp['model'] === 'string' ? resp['model'] : reqModel,
    content,
    stop_reason: mapStopReason(choice['finish_reason']),
    stop_sequence: null,
    usage: {
      input_tokens: typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : 0,
      output_tokens: typeof usage['completion_tokens'] === 'number' ? usage['completion_tokens'] : 0,
    },
  };
}

function mapStopReason(finish: Json | undefined): Json {
  if (typeof finish !== 'string') return null;
  return FINISH_TO_STOP[finish] ?? 'end_turn';
}

function parseArgs(args: Json | undefined): Json {
  if (typeof args !== 'string') return {};
  try {
    return JSON.parse(args) as Json;
  } catch {
    return {};
  }
}

/** Anthropic error envelope (`{type:'error', error:{type, message}}`) for a given HTTP status. */
export function anthropicError(status: number, message: string): Record<string, Json> {
  const type =
    status === 400
      ? 'invalid_request_error'
      : status === 401
        ? 'authentication_error'
        : status === 403
          ? 'permission_error'
          : status === 429
            ? 'rate_limit_error'
            : 'api_error';
  return { type: 'error', error: { type, message } };
}

function copyIfNumber(dst: Record<string, Json>, src: Record<string, Json>, key: string): void {
  if (typeof src[key] === 'number') dst[key] = src[key];
}

function isObject(v: Json | undefined): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Coerce a Json field to a string, defaulting non-strings to '' (fail-safe mapping). */
function str(v: Json | undefined): string {
  return typeof v === 'string' ? v : '';
}
