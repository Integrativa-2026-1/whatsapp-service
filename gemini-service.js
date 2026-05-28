// Gemini-based AI intent classifier — called only when intent-parser.js returns matched: false.
// Uses Gemini 2.5 Flash (free tier available, no credit card required).
//
// OPTIMIZATIONS to minimize API calls:
//   1. Only called when the deterministic parser fails (~20% of messages)
//   2. No extra HTTP call for auth context — connection checks happen in the switch
//   3. Simple in-process cache: same sender + same message = reuse last result
//   4. thinkingBudget: 0 — disables thinking mode, faster and cheaper

const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash";

// Simple in-process cache: Map<`${sender}:${message}`, result>
const intentCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, { timestamp }] of intentCache.entries()) {
    if (now - timestamp > CACHE_TTL_MS) intentCache.delete(key);
  }
}, 10 * 60 * 1000).unref();

const SYSTEM_ACTIONS = [
  "CONNECT_GOOGLE",
  "CONNECT_AVA",
  "LIST_GOOGLE_ACTIVITIES",
  "LIST_AVA_ACTIVITIES",
  "LIST_ACTIVITIES",
  "SUBMIT_GOOGLE",
  "SUBMIT_AVA",
  "SUBMIT_ACTIVITY",
  "GET_DEADLINES",
  "GET_GRADES",
  "GET_MATERIALS",
  "GREETING",
  "AMBIGUOUS_PLATFORM",
  "CHAT",
];

const FALLBACK = {
  intent: "CHAT",
  platform: null,
  chatResponse: "Desculpe, tive um problema ao processar sua mensagem. Pode tentar novamente?",
  requiresPlatformChoice: false,
};

function buildPrompt(message) {
  return `You are classifying messages for a WhatsApp academic assistant bot called UniEntrega.

IMPORTANT: Return ONLY a valid JSON object. No markdown, no code blocks, no explanation.

User message: "${message}"

Classify using ONLY these intent values:
${SYSTEM_ACTIONS.join(", ")}

Rules:
- "intent" must be exactly one value from the list above
- "platform" must be "GOOGLE", "AVA", or null
- "requiresPlatformChoice" must be true only if intent is clear but platform is ambiguous
- "chatResponse" must ALWAYS be in Brazilian Portuguese
- GREETING: warm welcome, say you are an academic assistant, list commands briefly
- AMBIGUOUS_PLATFORM or requiresPlatformChoice true: ask which platform (Google Classroom ou AVA?)
- CHAT (off-topic): answer naturally in Brazilian Portuguese, then gently nudge back to academic context
- Academic intents: short friendly acknowledgment in Brazilian Portuguese
- When in doubt: use CHAT

Return this exact structure:
{"intent":"LIST_ACTIVITIES","platform":null,"requiresPlatformChoice":false,"chatResponse":"Claro! Vou buscar suas atividades agora..."}`;
}

function extractJSON(text) {
  if (!text) return null;

  try {
    return JSON.parse(text.trim());
  } catch (_) {}

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const cleaned = match[0]
        .replace(/,\s*}/g, "}")
        .replace(/,\s*]/g, "]");
      return JSON.parse(cleaned);
    } catch (_) {}
  }

  return null;
}

async function classifyWithGemini(message, _context = {}, sender = null) {
  if (!GEMINI_API_KEY) {
    console.error("[Gemini] GEMINI_API_KEY not set in .env");
    return FALLBACK;
  }

  const cacheKey = `${sender || "unknown"}:${message.toLowerCase().trim()}`;
  const cached = intentCache.get(cacheKey);
  if (cached) {
    console.log(`[Gemini] Cache hit for: "${message}"`);
    return cached.result;
  }

  const prompt = buildPrompt(message);

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: MODEL,
      generationConfig: {
        temperature: 0.1,
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    });

    const result = await model.generateContent(prompt);
    const rawText = result.response.text().trim();

    console.log(`[Gemini] Raw response: ${rawText.slice(0, 200)}`);

    const parsed = extractJSON(rawText);

    if (parsed && parsed.intent && parsed.chatResponse) {
      console.log(`[Gemini] Intent classified: ${parsed.intent}`);
      intentCache.set(cacheKey, { result: parsed, timestamp: Date.now() });
      return parsed;
    }

    console.warn(`[Gemini] Invalid JSON response: ${rawText.slice(0, 150)}`);
    return FALLBACK;

  } catch (error) {
    const isQuotaError =
      error.message?.includes("429") || error.message?.includes("quota");
    const isAuthError =
      error.message?.includes("403") || error.message?.includes("API key");

    if (isQuotaError) {
      console.error("[Gemini] Rate limit hit. Using fallback.");
    } else if (isAuthError) {
      console.error("[Gemini] Invalid API key. Check GEMINI_API_KEY in .env");
    } else {
      console.error("[Gemini] Unexpected error:", error.message);
    }

    return FALLBACK;
  }
}

module.exports = { classifyWithGemini, SYSTEM_ACTIONS };
