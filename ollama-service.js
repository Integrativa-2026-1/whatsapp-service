// Ollama-based AI intent classifier — called only when intent-parser.js returns matched: false.
// Uses phi3 (3.8B) for reliable JSON output on local hardware.
// Returns a structured intent object or FALLBACK if parsing fails after retries.

const { Ollama } = require("ollama");

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "phi3";
const TIMEOUT_MS = 20000;
const MAX_RETRIES = 2;

const ollama = new Ollama({ host: OLLAMA_HOST });

// All possible system actions
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

function buildPrompt(message, context) {
  // Prompt kept intentionally short and direct — phi3 performs better with concise instructions.
  // The "chatResponse" field must always be in Brazilian Portuguese.
  return `You are an academic assistant inside a WhatsApp bot called UniEntrega.

IMPORTANT: Return ONLY a valid JSON object. No markdown, no explanation, no text outside the JSON.

User context:
- Google Classroom connected: ${context.googleConnected ? "yes" : "no"}
- AVA (Moodle) connected: ${context.avaConnected ? "yes" : "no"}

User message: "${message}"

Classify the message using ONLY these intent values:
${SYSTEM_ACTIONS.join(", ")}

Rules:
- "intent" must be exactly one value from the list above
- "platform" must be "GOOGLE", "AVA", or null
- "requiresPlatformChoice" must be true only if intent is clear but platform (google vs ava) is ambiguous
- "chatResponse" must ALWAYS be written in Brazilian Portuguese
- For GREETING: warm welcome, mention you are an academic assistant, list available commands briefly
- For AMBIGUOUS_PLATFORM or requiresPlatformChoice true: ask which platform (Google Classroom ou AVA?)
- For CHAT (off-topic): answer the question in Brazilian Portuguese, then gently nudge back to academic context
- For academic intents: write a short friendly acknowledgment in Brazilian Portuguese
- When in doubt, use CHAT

Respond with this exact JSON structure and nothing else:
{"intent":"LIST_ACTIVITIES","platform":null,"requiresPlatformChoice":false,"chatResponse":"Claro! Vou buscar suas atividades agora..."}`;
}

// Extracts JSON even when the model wraps it in markdown or adds preamble text.
function extractJSON(text) {
  if (!text) return null;

  // Try direct parse first (clean output)
  try {
    return JSON.parse(text.trim());
  } catch (_) {}

  // Extract first {...} block — handles preamble text and markdown fences
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

async function classifyWithOllama(message, context = {}) {
  const prompt = buildPrompt(message, context);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await ollama.chat({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: {
          temperature: 0.1, // low temperature → more deterministic JSON output
          num_predict: 200, // cap tokens — prevents extra text after the JSON
        },
      }, { signal: controller.signal });

      clearTimeout(timer);

      const rawText = response.message?.content?.trim() ?? "";
      console.log(`[Ollama] Raw response attempt ${attempt}: ${rawText.slice(0, 200)}`);

      const parsed = extractJSON(rawText);

      if (parsed && parsed.intent && parsed.chatResponse) {
        console.log(`[Ollama] Intent classified on attempt ${attempt}: ${parsed.intent}`);
        return parsed;
      }

      console.warn(`[Ollama] Attempt ${attempt}: invalid JSON. Raw: ${rawText.slice(0, 150)}`);

      if (attempt === MAX_RETRIES) {
        console.error("[Ollama] Failed to get valid JSON after all attempts. Using fallback.");
        return FALLBACK;
      }

      await new Promise((r) => setTimeout(r, 1000));

    } catch (err) {
      clearTimeout(timer);

      const isTimeout = err.name === "AbortError" || err.message?.includes("abort");
      const isOffline =
        err.message?.includes("ECONNREFUSED") || err.message?.includes("fetch failed");

      if (isTimeout) {
        console.error(`[Ollama] Timeout on attempt ${attempt} (${TIMEOUT_MS / 1000}s).`);
      } else if (isOffline) {
        console.error("[Ollama] Service offline. Using fallback.");
        return FALLBACK;
      } else {
        console.error(`[Ollama] Unexpected error on attempt ${attempt}:`, err.message);
      }

      if (attempt === MAX_RETRIES) return FALLBACK;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return FALLBACK;
}

module.exports = { classifyWithOllama, SYSTEM_ACTIONS };
