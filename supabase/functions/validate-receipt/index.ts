import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@1.7.0";
import {
  GENERIC_ERROR_MESSAGE,
  AI_BUSY_MESSAGE,
  PAYLOAD_TOO_LARGE_MESSAGE,
  QUOTA_RPC,
  RATE_LIMIT_MESSAGE,
  isDeclaredBodyTooLarge,
  isImageTooLarge,
  quotaOutcome,
} from "./limits.ts";
import { type NormalizedReceipt, normalizeExtraction } from "./normalize.ts";
import { type ClaudeImageType, PRIMARY_MODEL, buildMessagesRequest, toClaudeImageType } from "./prompt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type ReadOutcome =
  | { ok: true; receipt: NormalizedReceipt; model: string }
  | { ok: false; status: number };

/**
 * Uma chamada ao Claude já normalizada. Recusa, resposta cortada ou JSON
 * inválido viram leitura vazia (low): a pessoa preenche à mão, nada quebra.
 */
async function readReceipt(
  client: Anthropic,
  model: string,
  mediaType: ClaudeImageType,
  imageBase64: string,
): Promise<ReadOutcome> {
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create(buildMessagesRequest(model, mediaType, imageBase64));
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return { ok: false, status: 429 };
    }
    if (error instanceof Anthropic.APIError) {
      console.error("Claude error:", model, error.status, error.message);
      // 529 = API sobrecarregada: para a pessoa é o mesmo "ocupado" do 429.
      return { ok: false, status: error.status === 529 ? 429 : (error.status ?? 500) };
    }
    throw error;
  }

  // O fallback pode ter respondido com outro modelo: o log mede quem leu.
  const servedBy = response.model ?? model;
  if (response.stop_reason === "refusal") {
    console.error("validate-receipt: leitura recusada", servedBy, response.stop_details?.category ?? null);
    return { ok: true, receipt: normalizeExtraction({}), model: servedBy };
  }
  if (response.stop_reason === "max_tokens") {
    console.error("validate-receipt: resposta cortada em max_tokens", servedBy);
  }

  let raw: unknown = {};
  const text = response.content.find((block) => block.type === "text");
  if (text && text.type === "text") {
    try {
      raw = JSON.parse(text.text);
    } catch {
      console.error("validate-receipt: JSON inválido do", servedBy);
    }
  }
  return { ok: true, receipt: normalizeExtraction(raw), model: servedBy };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // JWT obrigatório; a cota por usuário é conferida antes de chamar o Claude.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return new Response(
        JSON.stringify({ error: "unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return new Response(
        JSON.stringify({ error: "supabase env not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const jwt = authHeader.slice("bearer ".length).trim();
    const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: authError } = await supabaseAuth.auth.getUser(jwt);
    if (authError || !userData?.user) {
      return new Response(
        JSON.stringify({ error: "unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Recusa corpo grande antes de ler (quando o cliente declara o tamanho) e
    // de novo depois do parse (upload sem Content-Length).
    if (isDeclaredBodyTooLarge(req.headers.get("content-length"))) {
      return new Response(
        JSON.stringify({ error: PAYLOAD_TOO_LARGE_MESSAGE }),
        { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { image_base64, mime_type } = await req.json();

    if (isImageTooLarge(image_base64)) {
      return new Response(
        JSON.stringify({ error: PAYLOAD_TOO_LARGE_MESSAGE }),
        { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!image_base64 || !mime_type) {
      return new Response(
        JSON.stringify({ error: "image_base64 and mime_type are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const mediaType = toClaudeImageType(mime_type);
    if (!mediaType) {
      return new Response(
        JSON.stringify({
          ...normalizeExtraction({}),
          model_used: null,
          error: "Formato não suportado. Use PNG, JPEG, GIF ou WebP.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Cota por hora conferida com o JWT do próprio usuário (auth.uid() na RPC).
    // Só pedido válido consome cota: formato e tamanho já foram checados acima.
    const quota = quotaOutcome(await supabaseAuth.rpc(QUOTA_RPC));
    if (quota === "exceeded") {
      return new Response(
        JSON.stringify({ error: RATE_LIMIT_MESSAGE }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "3600" } }
      );
    }
    if (quota === "unavailable") {
      console.error("validate-receipt: falha ao conferir a cota");
      return new Response(
        JSON.stringify({ error: GENERIC_ERROR_MESSAGE }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const read = await readReceipt(client, PRIMARY_MODEL, mediaType, image_base64);

    if (!read.ok) {
      if (read.status === 429) {
        return new Response(
          JSON.stringify({ error: AI_BUSY_MESSAGE }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ error: GENERIC_ERROR_MESSAGE }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const result = read.receipt;
    const modelUsed = read.model;

    // Sem valores no log: só qual modelo respondeu e por quê, para medir custo e acerto.
    console.log(JSON.stringify({
      fn: "validate-receipt",
      model_used: modelUsed,
      amount_confidence: result.amount_confidence,
      date_confidence: result.date_confidence,
      issues: result.issues,
    }));

    return new Response(JSON.stringify({ ...result, model_used: modelUsed }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    // Detalhe só no log do servidor; o cliente recebe texto genérico.
    console.error("validate-receipt error:", e);
    return new Response(
      JSON.stringify({ error: GENERIC_ERROR_MESSAGE }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
