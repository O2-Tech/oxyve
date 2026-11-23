/**
 * Corpo da leitura de comprovante no Claude (validate-receipt/prompt.ts).
 * Não chama a API: confere só o que a função manda.
 */
import { describe, it, expect } from 'vitest';
import {
  PRIMARY_MODEL,
  RECEIPT_SCHEMA,
  buildMessagesRequest,
  toClaudeImageType,
} from '../../supabase/functions/validate-receipt/prompt.ts';

describe('validate-receipt: pedido ao Claude', () => {
  const body = buildMessagesRequest(PRIMARY_MODEL, 'image/jpeg', 'QUJD');

  it('usa o Opus 5.5 com saída estruturada no schema do comprovante', () => {
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.output_config.format).toEqual({ type: 'json_schema', schema: RECEIPT_SCHEMA });
    expect(body.output_config.effort).toBe('medium');
  });

  it('não manda parâmetros que a API recusa', () => {
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('thinking');
  });

  it('liga o fallback do servidor com o header que combina com "default"', () => {
    expect(body.fallbacks).toBe('default');
    expect(body.betas).toEqual(['server-side-fallback-2026-07-01']);
  });

  it('manda a imagem em base64 antes do texto', () => {
    const [image, text] = body.messages[0].content;
    expect(image).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
    expect(text.type).toBe('text');
  });

  it('schema: todo campo é obrigatório e nada além deles', () => {
    expect([...RECEIPT_SCHEMA.required].sort()).toEqual(Object.keys(RECEIPT_SCHEMA.properties).sort());
    expect(RECEIPT_SCHEMA.additionalProperties).toBe(false);
  });

  it('schema: o que pode faltar na foto aceita null', () => {
    for (const campo of ['extracted_date', 'extracted_amount_cents', 'extracted_cnpj', 'extracted_supplier'] as const) {
      expect(RECEIPT_SCHEMA.properties[campo].anyOf).toContainEqual({ type: 'null' });
    }
  });
});

describe('validate-receipt: formatos de imagem', () => {
  it('aceita os formatos do Claude e troca image/jpg por image/jpeg', () => {
    expect(toClaudeImageType('image/jpg')).toBe('image/jpeg');
    expect(toClaudeImageType('image/png')).toBe('image/png');
    expect(toClaudeImageType('image/webp')).toBe('image/webp');
  });

  it('recusa o que o Claude não lê', () => {
    expect(toClaudeImageType('image/heic')).toBeNull();
    expect(toClaudeImageType('application/pdf')).toBeNull();
  });
});
