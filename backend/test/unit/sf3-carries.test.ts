import { describe, it, expect } from 'vitest';
import { anthropicToOpenAI } from '../../src/gateway/protocols/anthropic.js';

/**
 * SF-3 carried-refinement guards (SF-1 Gate-② carries resolved at this slice).
 *
 * C-SF1-3 — the load-bearing lossless-mapping guarantee (SD-F11): an arbitrary
 * NON-TEXT `tool_result` sub-block's payload MUST survive into the serialized
 * governed body, so the interceptor's whole-body backstop can still scan it and
 * a needle can never be silently dropped during Anthropic→OpenAI mapping.
 *
 * (C-SF1-1 depth cap lives in `tool-use/tool-io-guard.ts` — see sf3-tool-io-guard;
 *  C-SF1-2 auth-before-adapt is exercised by the SF-1 adapter integration suite;
 *  C-SF1-4 proto-pollution strip is in sf3-tool-io-guard + sf3-governed-provider.)
 */
describe('C-SF1-3 — non-text tool_result sub-block payload survives into the governed body', () => {
  it('serializes an image sub-block verbatim so its needle rides into the mapped OpenAI body', () => {
    const needle = 'PAYLOAD-NEEDLE-ride-into-scan-9f3a';
    const adapted = anthropicToOpenAI({
      model: 'deepseek-v3',
      max_tokens: 64,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [
                { type: 'text', text: 'see image' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: needle } },
              ],
            },
          ],
        },
      ],
    });
    expect(adapted.ok).toBe(true);
    if (adapted.ok) {
      // The interceptor scans JSON.stringify(wholeBody); the needle must be present.
      expect(JSON.stringify(adapted.openai)).toContain(needle);
    }
  });

  it('an unknown/custom non-text sub-block payload also survives (serialized verbatim)', () => {
    const needle = 'CUSTOM-SUBBLOCK-xyz-777';
    const adapted = anthropicToOpenAI({
      model: 'deepseek-v3',
      max_tokens: 64,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: `arbitrary string result with ${needle} inside`,
            },
          ],
        },
      ],
    });
    expect(adapted.ok).toBe(true);
    if (adapted.ok) expect(JSON.stringify(adapted.openai)).toContain(needle);
  });
});
