const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const { isProcessed, markProcessed } = require("./message-cache");
const { parseIntent } = require("./intent-parser");
const { classifyWithGemini } = require("./gemini-service");

const AUTH_FOLDER = path.join(__dirname, "auth");
const API_URL = process.env.API_UNIENTREGA_URL;

let sock = null;
let latestQrCode = null;

function getLatestQrCode() {
  return latestQrCode;
}

async function callApi(endpoint, method = "GET", body = null) {
  const options = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`${API_URL}${endpoint}`, options);
  const data = await response.json();
  return data;
}

// ── CONVERSATION STATE ────────────────────────────────────────────────
// Map<whatsappNumber, { step, platform, activities, selectedActivity }>
// step values:
//   "AWAITING_ACTIVITY_SELECTION" — bot sent selection link, waiting for user to return
//   "AWAITING_ACTIVITY_NUMBER"    — legacy fallback (number-based selection)
//   "AWAITING_FILE"               — user picked activity, waiting for file
const conversationState = new Map();

// ── CONVERSATION HISTORY ──────────────────────────────────────────────
// Map<sender, Array<{ role: "user"|"bot", text: string }>>
// Keeps the last 6 messages per user to give Gemini context.
const conversationHistory = new Map();
const HISTORY_MAX = 6;

function addToHistory(sender, role, text) {
  if (!text || !text.trim()) return;
  const history = conversationHistory.get(sender) || [];
  history.push({ role, text: text.trim() });
  if (history.length > HISTORY_MAX) history.shift();
  conversationHistory.set(sender, history);
}

function getHistory(sender) {
  return conversationHistory.get(sender) || [];
}

async function callApiMultipart(endpoint, formData) {
  const response = await fetch(`${API_URL}${endpoint}`, {
    method: "POST",
    body: formData,
  });
  return await response.json();
}

// Fetches a short-lived token from api-unientrega and returns a clean URL.
// The user's WhatsApp JID (sender) is never exposed in the URL.
async function getCleanUrl(path, sender) {
  try {
    const data = await callApi(`/token?w=${encodeURIComponent(sender)}`);
    if (data.token) {
      return `${API_URL}${path}?t=${data.token}`;
    }
  } catch (_) {}
  // Fallback to w= param if token generation fails — better than breaking the flow
  return `${API_URL}${path}?w=${encodeURIComponent(sender)}`;
}

async function sendTyping(sender, isTyping = true) {
  try {
    await sock.sendPresenceUpdate(isTyping ? "composing" : "paused", sender);
  } catch (_) {
    // Typing indicator is best-effort — never block message flow on failure
  }
}

async function sendMessage(sender, textContent) {
  await sendTyping(sender, false);
  await sock.sendMessage(sender, { text: textContent });
  addToHistory(sender, "bot", textContent);
}

// Checks if the user is authenticated for a given platform.
// If not, sends a proactive login message and returns false.
async function checkAuth(sender, platform) {
  let statusData;
  try {
    statusData = await callApi(
      `/auth/status?whatsappNumber=${encodeURIComponent(sender)}`
    );
  } catch (_) {
    return true;
  }

  if (platform === "google" && !statusData.googleConnected) {
    const googleLoginUrl = await getCleanUrl("/entrar/google", sender);
    await sendMessage(sender,
      "🔗 Parece que sua conta do Google Classroom ainda não está conectada!\n\n" +
      `Clique no link para fazer login:\n${googleLoginUrl}`
    );
    return false;
  }

  if (platform === "ava" && !statusData.avaConnected) {
    const avaLoginUrl = await getCleanUrl("/entrar/ava", sender);
    await sendMessage(sender,
      "🎓 Parece que sua conta do AVA ainda não está conectada!\n\n" +
      `Clique no link para fazer login:\n${avaLoginUrl}`
    );
    return false;
  }

  return true;
}

// ── MESSAGE HANDLERS ──────────────────────────────────────────────────

async function handleDeliverActivityStart(sender, platform = "ava") {
  await sendTyping(sender);

  const authed = await checkAuth(sender, platform);
  if (!authed) return;

  const endpoint = platform === "google"
    ? `/classroom/activities?whatsappNumber=${encodeURIComponent(sender)}`
    : `/ava/activities?whatsappNumber=${encodeURIComponent(sender)}`;

  const data = await callApi(endpoint);
  const platformLabel = platform === "google" ? "Google Classroom" : "AVA";

  if (data.error) {
    await sendMessage(sender, `⚠️ ${data.error}`);
    return;
  }

  if (!data.activities || data.activities.length === 0) {
    await sendMessage(sender, `📭 Não encontrei nenhuma atividade disponível no ${platformLabel} no momento.`);
    return;
  }

  conversationState.set(sender, {
    step: "AWAITING_ACTIVITY_SELECTION",
    platform,
    activities: data.activities,
    selectedActivity: null,
  });

  const selectUrl = platform === "google"
    ? await getCleanUrl("/atividades/google", sender)
    : await getCleanUrl("/atividades/ava", sender);

  await sendMessage(sender,
    `📋 Aqui estão suas atividades do *${platformLabel}*!\n\n` +
    `Clique no link, escolha a atividade e o WhatsApp vai abrir com ela selecionada:\n\n` +
    `${selectUrl}`
  );
}

async function handleFileSubmission(sender, msg, state) {
  await sendTyping(sender);

  const selected = state.selectedActivity;

  const fileType =
    msg.message.documentMessage ||
    msg.message.documentWithCaptionMessage?.message?.documentMessage ||
    msg.message.imageMessage ||
    msg.message.videoMessage ||
    msg.message.audioMessage ||
    null;

  if (!fileType) {
    await sendMessage(sender, "❌ Não consegui processar o arquivo. Tente enviar novamente.");
    return;
  }

  const buffer = await downloadMediaMessage(msg, "buffer", {});

  const originalFilename = fileType.fileName || fileType.title || `arquivo-${Date.now()}`;
  const mimetype = fileType.mimetype || "application/octet-stream";

  console.log("\n==============================================");
  console.log("[FILE RECEIVED FROM WHATSAPP]");
  console.log(`From:          ${sender}`);
  console.log(`Activity:      ${selected.title} (ID: ${selected.id})`);
  console.log(`Course ID:     ${selected.courseId}`);
  console.log(`File Name:     ${originalFilename}`);
  console.log(`MIME Type:     ${mimetype}`);
  console.log(`Size (bytes):  ${buffer.length}`);
  console.log("==============================================\n");

  const form = new global.FormData();
  form.append("whatsappNumber", sender);
  form.append("courseId", String(selected.courseId));
  form.append("activityId", String(selected.id));
  form.append(
    "file",
    new Blob([buffer], { type: mimetype }),
    originalFilename
  );

  const platformLabel = state.platform === "google" ? "Google Classroom" : "AVA";
  const submitEndpoint = state.platform === "google" ? "/classroom/submit" : "/ava/submit";

  await sendMessage(sender, `⏳ Enviando sua atividade para o ${platformLabel}...`);

  const result = await callApiMultipart(submitEndpoint, form);

  conversationState.delete(sender);

  if (result.ok) {
    await sendMessage(sender, `✅ Atividade *${selected.title}* entregue com sucesso no ${platformLabel}! 🎉`);
  } else {
    await sendMessage(sender, `❌ Falha ao enviar: ${result.error || "Erro desconhecido."}`);
  }
}

// ── MAIN MESSAGE ROUTER ───────────────────────────────────────────────

async function handleMessage(sock, sender, msg) {
  // Start typing immediately — before any classification or API call
  await sendTyping(sender);

  const text =
    msg.message?.conversation?.trim() ||
    msg.message?.extendedTextMessage?.text?.trim() ||
    "";

  if (text) addToHistory(sender, "user", text);

  // ── In-progress conversation states take absolute priority ────────
  const state = conversationState.get(sender);

  if (state?.step === "AWAITING_ACTIVITY_SELECTION") {
    const matched = state.activities?.find(
      (a) => a.title.toLowerCase().trim() === text.toLowerCase().trim()
    );
    if (matched) {
      conversationState.set(sender, { ...state, step: "AWAITING_FILE", selectedActivity: matched });
      await sendMessage(sender, `📎 Atividade selecionada: *${matched.title}*\n\nAgora é só me mandar o arquivo! 😊`);
      return;
    }
    // Text doesn't match any activity title — clear state and fall through to normal classification
    conversationState.delete(sender);
  }

  if (state?.step === "AWAITING_ACTIVITY_NUMBER") {
    const matched = state.activities?.find(
      (a) => a.title.toLowerCase().trim() === text.toLowerCase().trim()
    );
    if (matched) {
      conversationState.set(sender, { ...state, step: "AWAITING_FILE", selectedActivity: matched });
      await sendMessage(sender, `📎 Atividade selecionada: *${matched.title}*\n\nAgora mande o arquivo da atividade.`);
    } else {
      const index = parseInt(text.trim(), 10) - 1;
      if (!isNaN(index) && index >= 0 && state.activities && index < state.activities.length) {
        const selected = state.activities[index];
        conversationState.set(sender, { ...state, step: "AWAITING_FILE", selectedActivity: selected });
        await sendMessage(sender, `📎 Atividade selecionada: *${selected.title}*\n\nAgora mande o arquivo da atividade.`);
      } else {
        await sendMessage(sender, "❌ Não encontrei essa atividade. Acesse o link novamente e clique na atividade desejada.");
      }
    }
    return;
  }

  if (state?.step === "AWAITING_FILE") {
    const hasFile =
      msg.message?.documentMessage ||
      msg.message?.documentWithCaptionMessage ||
      msg.message?.imageMessage ||
      msg.message?.videoMessage ||
      msg.message?.audioMessage;

    if (hasFile) {
      await handleFileSubmission(sender, msg, state);
    } else {
      await sendMessage(sender, "📎 Por favor, envie o arquivo da atividade.");
    }
    return;
  }

  // ── Skip classification if no text (file sent outside of a flow) ─
  if (!text) {
    await sendMessage(sender, "Olá! 👋 Sou seu assistente acadêmico. Envie uma mensagem de texto para começarmos!");
    return;
  }

  // ── Layer 1: Fast deterministic parser ────────────────────────────
  const deterministic = parseIntent(text);
  let finalIntent = deterministic.matched ? deterministic.intent : null;

  // ── Layer 2: Gemini classification for ambiguous messages ────────
  let aiResult = null;
  let chatResponse = null;
  let platform = deterministic.platform;

  if (!deterministic.matched) {
    aiResult = await classifyWithGemini(text, {}, sender, getHistory(sender));
    finalIntent = aiResult.intent;
    chatResponse = aiResult.chatResponse;
    platform = aiResult.platform || deterministic.platform;

    if (aiResult.requiresPlatformChoice || finalIntent === "AMBIGUOUS_PLATFORM") {
      await sendMessage(sender, chatResponse);
      return;
    }
  }

  // ── Route to the correct action ───────────────────────────────────

  switch (finalIntent) {

    case "POST_LOGIN_GOOGLE": {
      try {
        const data = await callApi(
          `/classroom/activities?whatsappNumber=${encodeURIComponent(sender)}`
        );
        if (data.error || !data.activities || data.activities.length === 0) {
          await sendMessage(sender, "✅ Google Classroom conectado! Não encontrei atividades pendentes por agora.");
          break;
        }
        const lines = data.activities.map((a) => {
          const deadline = a.dueDate
            ? ` — 📅 ${new Date(a.dueDate).toLocaleDateString("pt-BR")}`
            : "";
          return `📚 ${a.courseName} - ${a.title}${deadline}`;
        });
        await sendMessage(sender, `✅ Google Classroom conectado! Aqui estão suas atividades:\n\n${lines.join("\n")}`);
      } catch (error) {
        await sendMessage(sender, "✅ Login realizado! Tive um problema ao buscar suas atividades, mas já estamos conectados.");
      }
      break;
    }

    case "POST_LOGIN_AVA": {
      try {
        const data = await callApi(
          `/ava/activities?whatsappNumber=${encodeURIComponent(sender)}`
        );
        if (data.error || !data.activities || data.activities.length === 0) {
          await sendMessage(sender, "✅ AVA conectado! Não encontrei atividades pendentes por agora.");
          break;
        }
        const lines = data.activities.map((a) => {
          const deadline = a.dueDate
            ? ` — 📅 ${new Date(a.dueDate).toLocaleDateString("pt-BR")}`
            : "";
          return `📚 ${a.courseName} - ${a.title}${deadline}`;
        });
        await sendMessage(sender, `✅ AVA conectado! Aqui estão suas atividades:\n\n${lines.join("\n")}`);
      } catch (error) {
        await sendMessage(sender, "✅ Login realizado! Tive um problema ao buscar suas atividades, mas já estamos conectados.");
      }
      break;
    }

    case "GREETING":
      await sendMessage(sender, chatResponse ||
        "Olá! 👋 Sou o UniEntrega, seu assistente acadêmico. Estou aqui para te ajudar com atividades, prazos e entregas!\n\nVocê pode me pedir coisas como:\n- Ver suas tarefas no AVA\n- Ver suas tarefas no Google Classroom\n- Entregar uma atividade no AVA\n- Ver o prazo das suas atividades\n\n Como posso te ajudar hoje? 😊"
      );
      break;

    case "CONNECT_GOOGLE": {
      try {
        const statusData = await callApi(
          `/auth/status?whatsappNumber=${encodeURIComponent(sender)}`
        );
        if (statusData.googleConnected) {
          await sendMessage(sender, "✅ Você já está conectado ao Google Classroom!");
          return;
        }
        const googleLoginUrl = await getCleanUrl("/entrar/google", sender);
        await sendMessage(sender, `🔗 Clique no link abaixo para conectar sua conta do Google Classroom:\n\n${googleLoginUrl}`);
      } catch (error) {
        console.error("[WhatsApp] Error fetching Google auth URL:", error.message);
        await sendMessage(sender, "❌ Erro ao conectar com o serviço. Tente novamente em instantes.");
      }
      break;
    }

    case "CONNECT_AVA": {
      try {
        const statusData = await callApi(
          `/auth/status?whatsappNumber=${encodeURIComponent(sender)}`
        );
        if (statusData.avaConnected) {
          await sendMessage(sender, "✅ Você já está conectado ao AVA!");
          return;
        }
        const avaLoginUrl = await getCleanUrl("/entrar/ava", sender);
        await sendMessage(sender,
          `🎓 Clique no link abaixo para conectar sua conta do AVA (Moodle):\n\n${avaLoginUrl}\n\n` +
          `_Insira seu usuário e senha do AVA no formulário que vai abrir._`
        );
      } catch (error) {
        console.error("[WhatsApp] Error fetching AVA login URL:", error.message);
        await sendMessage(sender, "❌ Erro ao conectar com o serviço. Tente novamente em instantes.");
      }
      break;
    }

    case "LIST_GOOGLE_ACTIVITIES": {
      const authed = await checkAuth(sender, "google");
      if (!authed) break;
      try {
        const data = await callApi(
          `/classroom/activities?whatsappNumber=${encodeURIComponent(sender)}`
        );
        if (data.error) {
          await sendMessage(sender, `⚠️ ${data.error}`);
          break;
        }
        if (!data.activities || data.activities.length === 0) {
          await sendMessage(sender, "📭 Não há atividades no Google Classroom.");
          break;
        }
        const lines = data.activities.map((a) => {
          const deadline = a.dueDate
            ? ` — 📅 ${new Date(a.dueDate).toLocaleDateString("pt-BR")}`
            : "";
          return `📚 ${a.courseName} - ${a.title}${deadline}`;
        });
        await sendMessage(sender, `📋 *Suas atividades no Google Classroom:*\n\n${lines.join("\n")}`);
      } catch (error) {
        console.error("[WhatsApp] Error fetching Google activities:", error.message);
        await sendMessage(sender, "❌ Erro ao buscar atividades. Tente novamente em instantes.");
      }
      break;
    }

    case "LIST_AVA_ACTIVITIES": {
      const authed = await checkAuth(sender, "ava");
      if (!authed) break;
      try {
        const data = await callApi(
          `/ava/activities?whatsappNumber=${encodeURIComponent(sender)}`
        );
        if (data.error) {
          await sendMessage(sender, `⚠️ ${data.error}`);
          break;
        }
        if (!data.activities || data.activities.length === 0) {
          await sendMessage(sender, "📭 Não há atividades no AVA.");
          break;
        }
        const lines = data.activities.map((a) => {
          const deadline = a.dueDate
            ? ` — 📅 ${new Date(a.dueDate).toLocaleDateString("pt-BR")}`
            : "";
          return `📚 ${a.courseName} - ${a.title}${deadline}`;
        });
        await sendMessage(sender, `📋 *Suas atividades no AVA:*\n\n${lines.join("\n")}`);
      } catch (error) {
        console.error("[WhatsApp] Error fetching AVA activities:", error.message);
        await sendMessage(sender, "❌ Erro ao buscar atividades do AVA. Tente novamente em instantes.");
      }
      break;
    }

    case "LIST_ACTIVITIES": {
      await sendMessage(sender, chatResponse || "📚 Ótimo! Você quer ver as atividades do Google Classroom ou do AVA?");
      break;
    }

    case "SUBMIT_AVA": {
      await handleDeliverActivityStart(sender, "ava");
      break;
    }

    case "SUBMIT_GOOGLE": {
      await sendMessage(sender,
        "⏳ A entrega de atividades pelo Google Classroom ainda não está disponível.\n\n" +
        "Estamos trabalhando nessa funcionalidade e em breve você poderá entregar suas atividades por aqui. Fique atento às novidades! 🚀"
      );
      break;
    }

    case "SUBMIT_ACTIVITY": {
      await sendMessage(sender, chatResponse || "📬 Entendido! Você quer entregar pelo AVA ou pelo Google Classroom?");
      break;
    }

    case "GET_AVA_DEADLINES": {
      const authed = await checkAuth(sender, "ava");
      if (!authed) break;
      try {
        const data = await callApi(
          `/ava/deadlines?whatsappNumber=${encodeURIComponent(sender)}`
        );
        if (data.error) {
          await sendMessage(sender, `⚠️ ${data.error}`);
          break;
        }
        const upcoming = (data.activities || []).filter(
          (a) => a.dueDate && new Date(a.dueDate) > new Date()
        );
        if (upcoming.length === 0) {
          await sendMessage(sender, "📭 Nenhuma atividade com prazo definido no AVA.");
          break;
        }
        const lines = upcoming.slice(0, 10).map((a) => {
          const days = Math.ceil((new Date(a.dueDate) - new Date()) / (1000 * 60 * 60 * 24));
          const dateStr = new Date(a.dueDate).toLocaleDateString("pt-BR");
          const urgency = days <= 2 ? "🔴" : days <= 7 ? "🟡" : "🟢";
          return `${urgency} *${a.title}*\n   ${a.courseName} — ${dateStr} (${days}d)`;
        });
        const nextMsg = data.nextDeadline
          ? `\n\n📌 *Mais urgente:* ${data.nextDeadline.title} — ${new Date(data.nextDeadline.dueDate).toLocaleDateString("pt-BR")}`
          : "";
        await sendMessage(sender, `⏰ *Próximos prazos no AVA:*\n\n${lines.join("\n\n")}${nextMsg}`);
      } catch (error) {
        await sendMessage(sender, "❌ Erro ao buscar prazos do AVA.");
      }
      break;
    }

    case "GET_GOOGLE_DEADLINES": {
      const authed = await checkAuth(sender, "google");
      if (!authed) break;
      try {
        const data = await callApi(
          `/classroom/deadlines?whatsappNumber=${encodeURIComponent(sender)}`
        );
        if (data.error) {
          await sendMessage(sender, `⚠️ ${data.error}`);
          break;
        }
        const upcoming = (data.activities || []).filter(
          (a) => a.dueDate && new Date(a.dueDate) > new Date()
        );
        if (upcoming.length === 0) {
          await sendMessage(sender, "📭 Nenhuma atividade com prazo definido no Google Classroom.");
          break;
        }
        const lines = upcoming.slice(0, 10).map((a) => {
          const days = Math.ceil((new Date(a.dueDate) - new Date()) / (1000 * 60 * 60 * 24));
          const dateStr = new Date(a.dueDate).toLocaleDateString("pt-BR");
          const urgency = days <= 2 ? "🔴" : days <= 7 ? "🟡" : "🟢";
          return `${urgency} *${a.title}*\n   ${a.courseName} — ${dateStr} (${days}d)`;
        });
        const nextMsg = data.nextDeadline
          ? `\n\n📌 *Mais urgente:* ${data.nextDeadline.title} — ${new Date(data.nextDeadline.dueDate).toLocaleDateString("pt-BR")}`
          : "";
        await sendMessage(sender, `⏰ *Próximos prazos no Google Classroom:*\n\n${lines.join("\n\n")}${nextMsg}`);
      } catch (error) {
        await sendMessage(sender, "❌ Erro ao buscar prazos do Google Classroom.");
      }
      break;
    }

    case "GET_DEADLINES": {
      await sendMessage(sender, chatResponse || "⏰ Quer ver os prazos do AVA ou do Google Classroom?");
      break;
    }

    case "GET_GRADES":
    case "GET_MATERIALS": {
      await sendMessage(sender, "📊 Essa funcionalidade ainda está em desenvolvimento e chegará em breve!");
      break;
    }

    case "CHAT":
    default: {
      if (chatResponse) {
        await sendMessage(sender, chatResponse);
      } else {
        await sock.sendMessage(sender, {
          text: "Hmm, não entendi muito bem. 🤔 Sou seu assistente acadêmico — posso te ajudar com atividades, prazos e entregas!",
        });
      }
      break;
    }
  }
}

// ── BAILEYS SETUP ─────────────────────────────────────────────────────

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`[WhatsApp] Initializing with Baileys version: ${version.join(".")}`);

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQrCode = qr;
      console.log(
        "[WhatsApp] New QR Code generated! Available at http://localhost:" +
          (process.env.PORT || 3000) +
          "/qr"
      );
    }

    if (connection === "open") {
      latestQrCode = null;
      console.log("[WhatsApp] Successfully connected and authenticated!");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(
        `[WhatsApp] Connection closed (${statusCode}). ${
          isLoggedOut ? "Session removed." : "Reconnecting in 3s..."
        }`
      );

      if (!isLoggedOut) {
        setTimeout(() => startWhatsApp(), 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const sender = msg.key.remoteJid;
      if (!sender || sender.endsWith("@broadcast") || sender.endsWith("@g.us")) continue;

      const messageId = msg.key.id;
      if (isProcessed(messageId)) continue;
      markProcessed(messageId);

      const text =
        msg.message?.conversation?.trim() ||
        msg.message?.extendedTextMessage?.text?.trim() ||
        "";

      console.log(`[WhatsApp] Message received from [${sender}]: "${text || "(file)"}"`);

      try {
        await handleMessage(sock, sender, msg);
      } catch (error) {
        console.error(`[WhatsApp] Unhandled error for [${sender}]:`, error.message);
      }
    }
  });
}

async function disconnectWhatsApp() {
  latestQrCode = null;
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      await fs.promises.rm(AUTH_FOLDER, { recursive: true, force: true });
    }
    console.log("[WhatsApp] Session cleared from local storage.");
  } catch (error) {
    console.error("[WhatsApp] Error deleting authentication files:", error.message);
  }
}

module.exports = {
  startWhatsApp,
  disconnectWhatsApp,
  getLatestQrCode,
};
