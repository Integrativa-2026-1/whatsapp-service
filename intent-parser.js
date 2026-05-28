// Deterministic intent parser — classifies common intents WITHOUT calling any AI model.
// Handles ~80% of traffic instantly. AI is only called for ambiguous/conversational input.

const PLATFORM_KEYWORDS = {
  GOOGLE: ["google", "classroom", "google classroom", "sala de aula"],
  AVA: ["ava", "moodle", "portal", "plataforma ava"],
};

const INTENT_RULES = [
  {
    intent: "POST_LOGIN_GOOGLE",
    patterns: [
      "pronto ja fiz o login com o google",
      "ja fiz o login com o google",
      "login com o google",
      "conectei o google",
      "entrei com o google",
    ],
  },
  {
    intent: "POST_LOGIN_AVA",
    patterns: [
      "pronto ja fiz o login com o ava",
      "ja fiz o login com o ava",
      "login com o ava",
      "conectei o ava",
      "entrei com o ava",
    ],
  },
  {
    intent: "CONNECT_GOOGLE",
    patterns: [
      "conectar google", "conectar classroom", "integrar google", "integrar classroom",
      "ligar google", "vincular google", "adicionar google", "login google",
      "entrar google", "autenticar google",
    ],
  },
  {
    intent: "CONNECT_AVA",
    patterns: [
      "conectar ava", "conectar moodle", "integrar ava", "integrar moodle",
      "ligar ava", "vincular ava", "adicionar ava", "login ava",
      "entrar ava", "autenticar ava",
    ],
  },
  {
    intent: "LIST_GOOGLE_ACTIVITIES",
    patterns: [
      "atividades google", "atividades do google", "tarefas google",
      "ver atividades google", "listar atividades google", "mostrar atividades google",
    ],
  },
  {
    intent: "LIST_AVA_ACTIVITIES",
    patterns: [
      "atividades ava", "atividades do ava", "tarefas ava",
      "ver atividades ava", "listar atividades ava", "mostrar atividades ava",
    ],
  },
  {
    intent: "LIST_ACTIVITIES",
    patterns: [
      "ver atividades", "minhas atividades", "listar atividades", "mostrar atividades",
      "quais atividades", "atividades pendentes", "tarefas", "trabalhos",
      "o que tenho", "tenho tarefa",
    ],
  },
  {
    intent: "SUBMIT_AVA",
    patterns: [
      "entregar atividade ava", "enviar atividade ava", "submeter atividade ava",
      "entregar tarefa ava", "enviar tarefa ava",
    ],
  },
  {
    intent: "SUBMIT_GOOGLE",
    patterns: [
      "entregar atividade google", "enviar atividade google", "submeter atividade google",
      "entregar tarefa google", "enviar tarefa google",
    ],
  },
  {
    intent: "SUBMIT_ACTIVITY",
    patterns: [
      "entregar atividade", "enviar atividade", "publicar atividade", "submeter atividade",
      "mandar atividade", "postar atividade", "fazer entrega", "entregar tarefa",
      "submeter tarefa", "enviar tarefa",
    ],
  },
  {
    intent: "GET_AVA_DEADLINES",
    patterns: [
      "prazo ava", "prazos ava", "quando vence ava", "data entrega ava",
      "proxima atividade ava", "deadline ava", "atividade mais proxima ava",
    ],
  },
  {
    intent: "GET_GOOGLE_DEADLINES",
    patterns: [
      "prazo google", "prazos google", "quando vence google", "data entrega google",
      "proxima atividade google", "deadline google", "atividade mais proxima google",
    ],
  },
  {
    intent: "GET_DEADLINES",
    patterns: [
      "prazos", "prazo", "datas", "vencimento", "quando vence", "quando e a entrega",
      "data de entrega", "deadline", "quando entregar", "proximo prazo",
      "proxima atividade", "atividade mais proxima", "qual atividade vence primeiro",
      "o que vence", "o que ta vencendo",
    ],
  },
  {
    intent: "GET_GRADES",
    patterns: [
      "notas", "nota", "grades", "minha nota", "resultado", "resultados",
      "ver notas", "minhas notas", "pontuacao", "desempenho",
    ],
  },
  {
    intent: "GET_MATERIALS",
    patterns: [
      "materiais", "material", "arquivos", "arquivo", "apostila", "slides",
      "ver materiais", "baixar material", "conteudo", "recursos",
    ],
  },
];

const GREETING_PATTERNS = [
  "oi", "ola", "olá", "hey", "eai", "e ai", "bom dia", "boa tarde", "boa noite",
  "hello", "hi", "opa", "salve", "tudo bem", "tudo bom", "como vai", "oi tudo bem",
];

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectPlatform(normalized) {
  for (const [platform, keywords] of Object.entries(PLATFORM_KEYWORDS)) {
    if (keywords.some((kw) => normalized.includes(kw))) return platform;
  }
  return null;
}

function isGreeting(normalized) {
  return GREETING_PATTERNS.some(
    (g) => normalized === g || normalized.startsWith(g + " ") || normalized.endsWith(" " + g)
  );
}

function parseIntent(message) {
  if (!message) return { matched: false, confidence: 0, platform: null, intent: "CHAT" };

  const norm = normalize(message);
  const platform = detectPlatform(norm);

  if (isGreeting(norm)) {
    return { matched: true, confidence: 1.0, platform: null, intent: "GREETING" };
  }

  let bestIntent = null;
  let bestScore = 0;

  for (const rule of INTENT_RULES) {
    for (const pattern of rule.patterns) {
      const normPattern = normalize(pattern);
      if (norm === normPattern) {
        if (1.0 > bestScore) { bestScore = 1.0; bestIntent = rule.intent; }
      } else if (norm.includes(normPattern)) {
        const score = Math.min(0.95, 0.7 + (normPattern.length / norm.length) * 0.25);
        if (score > bestScore) { bestScore = score; bestIntent = rule.intent; }
      }
    }
  }

  if (bestIntent && bestScore >= 0.7) {
    return { matched: true, confidence: bestScore, platform, intent: bestIntent };
  }

  return { matched: false, confidence: bestScore, platform, intent: "CHAT" };
}

module.exports = { parseIntent, normalize };
