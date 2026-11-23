// Prompt e schema da leitura de comprovante. Módulo puro (sem Deno).
import { EXPENSE_KIND_HINTS, RECEIPT_ISSUES, RECEIPT_TYPES } from "./normalize.ts";

// Claude Opus 5.5 com saída estruturada (nov/2026, troca da OpenAI): o schema
// garante JSON válido sem forçar ferramenta. Antes era o gpt-4.1, escolhido em
// teste com notas reais porque o gpt-4o-mini inventava valor e ano.
export const PRIMARY_MODEL = "claude-opus-5-5";

export const SYSTEM_PROMPT = [
  "Você lê comprovantes de despesa brasileiros para um app de reembolso. Os tipos mais comuns:",
  "NFC-e / cupom fiscal / SAT (supermercado, restaurante, farmácia), DANFE de NF-e, recibo de app",
  "(Uber, 99, iFood), nota de posto de combustível, ticket de estacionamento e recibo de pedágio.",
  "",
  "VALOR (extracted_amount_cents, em centavos):",
  "- É o total efetivamente pago: 'VALOR A PAGAR', 'TOTAL R$', 'Valor total', 'Total pago'.",
  "- Inclua taxa de serviço/gorjeta quando ela estiver somada no total pago (ex.: 'Total c/ serviço').",
  "- NUNCA use: subtotal; 'valor recebido', 'dinheiro', 'troco'; tributos aproximados",
  "  ('Val. aprox. tributos', Lei 12.741); desconto isolado; valor de um item; saldo ou limite.",
  "- Formato brasileiro: '1.234,56' = 123456 centavos; '45,90' = 4590. Ponto separa milhar, vírgula separa centavos.",
  "- Confira: se a nota lista itens, a soma dos itens (mais serviço, menos desconto) deve dar o total.",
  "  Se não bater ou algum dígito estiver duvidoso (5/6/8/9, 0/8), use amount_confidence 'medium'.",
  "- Se houver mais de um total e não der para saber qual foi pago, marque a issue 'multiple_totals'",
  "  e amount_confidence 'low'.",
  "",
  "DATA (extracted_date, YYYY-MM-DD):",
  "- É a data de emissão/da compra. NÃO use data de vencimento, validade, autorização futura ou a hora.",
  "- A nota costuma trazer dd/mm/aa ou dd/mm/aaaa: ano de 2 dígitos é 20xx (ex.: 15/10/26 = 2026-10-15).",
  "- Dia vem antes do mês (padrão brasileiro).",
  "",
  "CNPJ (extracted_cnpj): o do EMITENTE (quem vendeu), não o do consumidor nem CPF. Só dígitos.",
  "Sem CNPJ do emitente, use null.",
  "",
  "ESTABELECIMENTO (extracted_supplier): nome fantasia se houver, senão razão social. Curto",
  "(ex.: 'Posto Ipiranga Centro', não a razão social inteira com LTDA e endereço). Em app, o app (ex.: 'Uber').",
  "",
  "TIPO (receipt_type): 'nota_fiscal' (NF-e, NFC-e, SAT ou cupom fiscal com CNPJ), 'recibo' (recibo",
  "simples ou de app), 'comprovante_pix' (transferência PIX), 'comprovante_cartao' (via da maquininha",
  "sem nota fiscal) ou 'outro'.",
  "",
  "CONFIANÇA: amount_confidence e date_confidence por campo, e confidence geral. Use 'high' só quando",
  "o número está nítido e você tem certeza de que é o campo certo; 'medium' se leu mas há dúvida;",
  "'low' se chutou ou não achou.",
  "",
  "ISSUES (lista, vazia se a foto está boa): 'blurry' (tremida/desfocada), 'cropped' (cortada, total ou",
  "data fora da foto), 'multiple_totals', 'handwritten' (preenchida à mão), 'low_light' (escura),",
  "'not_a_receipt' (a foto não é um comprovante de despesa), 'other'.",
  "",
  "expense_kind_hint: 'food' (refeição, mercado, delivery de comida), 'transport' (combustível, app de",
  "transporte, estacionamento, pedágio) ou 'other'.",
  "",
  "Não invente: se não conseguir ler um campo com clareza, use null e confiança 'low'.",
].join("\n");

export const USER_PROMPT =
  "Leia este comprovante e extraia valor total pago, data de emissão, CNPJ do emitente, estabelecimento, tipo, confiança por campo e problemas da foto.";

const CONFIDENCE_ENUM = ["high", "medium", "low"];

// Saída estruturada exige todo campo em `required`; o que pode faltar na foto
// aceita null (o normalize trata null como "não lido").
const nullable = (type: "string" | "integer", description: string) => ({
  anyOf: [{ type }, { type: "null" }],
  description,
});

export const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    extracted_date: nullable("string", "Data de emissão no formato YYYY-MM-DD. Null se não identificada."),
    extracted_amount_cents: nullable(
      "integer",
      "Total efetivamente pago em centavos (R$ 1.234,56 = 123456). Null se não identificado.",
    ),
    extracted_cnpj: nullable("string", "CNPJ do emitente, só dígitos. Null se não houver."),
    extracted_supplier: nullable(
      "string",
      "Nome fantasia do estabelecimento (ou razão social), curto. Null se não identificado.",
    ),
    receipt_type: { type: "string", enum: [...RECEIPT_TYPES], description: "Tipo do documento." },
    confidence: { type: "string", enum: CONFIDENCE_ENUM, description: "Confiança geral na leitura." },
    amount_confidence: { type: "string", enum: CONFIDENCE_ENUM, description: "Confiança no valor total pago." },
    date_confidence: { type: "string", enum: CONFIDENCE_ENUM, description: "Confiança na data de emissão." },
    issues: {
      type: "array",
      items: { type: "string", enum: [...RECEIPT_ISSUES] },
      description: "Problemas da foto ou do documento. Vazio se nenhum.",
    },
    expense_kind_hint: {
      type: "string",
      enum: [...EXPENSE_KIND_HINTS],
      description: "Natureza provável da despesa.",
    },
  },
  required: [
    "extracted_date",
    "extracted_amount_cents",
    "extracted_cnpj",
    "extracted_supplier",
    "receipt_type",
    "confidence",
    "amount_confidence",
    "date_confidence",
    "issues",
    "expense_kind_hint",
  ],
  additionalProperties: false,
};

// Formatos de imagem que a API do Claude aceita; "image/jpg" vira "image/jpeg".
export const CLAUDE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type ClaudeImageType = (typeof CLAUDE_IMAGE_TYPES)[number];

export function toClaudeImageType(mimeType: string): ClaudeImageType | null {
  const t = mimeType === "image/jpg" ? "image/jpeg" : mimeType;
  return (CLAUDE_IMAGE_TYPES as readonly string[]).includes(t) ? (t as ClaudeImageType) : null;
}

/**
 * Corpo do messages.create (beta, por causa do fallback). Sem temperature: a
 * API atual recusa o parâmetro; a estabilidade da leitura vem do schema e do
 * prompt. Effort explícito porque o padrão do Opus 5.5 é medium e pode mudar.
 * fallbacks "default": se o modelo recusar a foto, a própria API tenta outro.
 */
export function buildMessagesRequest(model: string, mediaType: ClaudeImageType, imageBase64: string) {
  return {
    model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default" as const,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "image" as const, source: { type: "base64" as const, media_type: mediaType, data: imageBase64 } },
          { type: "text" as const, text: USER_PROMPT },
        ],
      },
    ],
    output_config: {
      effort: "medium" as const,
      format: { type: "json_schema" as const, schema: RECEIPT_SCHEMA },
    },
  };
}
