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
// Map<whatsappNumber, { step, activities, selectedActivity }>
// step values:
//   "AWAITING_ACTIVITY_NUMBER" — bot listed activities, waiting for user to pick one
//   "AWAITING_FILE"            — user picked activity, waiting for file
const conversationState = new Map();

async function callApiMultipart(endpoint, formData) {
  const response = await fetch(`${API_URL}${endpoint}`, {
    method: "POST",
    body: formData,
  });
  return await response.json();
}

async function sendTyping(sender, isTyping = true) {
  try {
    await sock.sendPresenceUpdate(isTyping ? "composing" : "paused", sender);
  } catch (_) {
    // Typing indicator is best-effort — never block message flow on failure
  }
}

// ── MESSAGE HANDLERS ──────────────────────────────────────────────────

async function handleDeliverActivityStart(sender, platform = "ava") {
  await sendTyping(sender);

  const endpoint =
    platform === "google"
      ? `/classroom/activities?whatsappNumber=${encodeURIComponent(sender)}`
      : `/ava/activities?whatsappNumber=${encodeURIComponent(sender)}`;

  const data = await callApi(endpoint);

  if (data.error) {
    await sendTyping(sender, false);
    await sock.sendMessage(sender, { text: `⚠️ ${data.error}` });
    return;
  }

  if (!data.activities || data.activities.length === 0) {
    await sendTyping(sender, false);
    await sock.sendMessage(sender, {
      text: `📭 Não há atividades disponíveis no ${platform === "google" ? "Google Classroom" : "AVA"} para entrega.`,
    });
    return;
  }

  conversationState.set(sender, {
    step: "AWAITING_ACTIVITY_NUMBER",
    platform,
    activities: data.activities,
    selectedActivity: null,
  });

  const lines = data.activities.map(
    (a, i) => `${i + 1} - ${a.title} — ${a.courseName}`
  );

  await sendTyping(sender, false);
  await sock.sendMessage(sender, {
    text: `📋 *Digite o número da atividade:*\n\n${lines.join("\n")}`,
  });
}

async function handleActivityNumberInput(sender, text, state) {
  const index = parseInt(text.trim(), 10) - 1;

  if (isNaN(index) || index < 0 || index >= state.activities.length) {
    await sendTyping(sender, false);
    await sock.sendMessage(sender, {
      text: `❌ Número inválido. Digite um número entre 1 e ${state.activities.length}.`,
    });
    return;
  }

  const selected = state.activities[index];

  conversationState.set(sender, {
    ...state,
    step: "AWAITING_FILE",
    selectedActivity: selected,
  });

  await sendTyping(sender, false);
  await sock.sendMessage(sender, {
    text: `📎 Atividade selecionada: *${selected.title}*\n\nMande o arquivo da atividade.`,
  });
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
    await sendTyping(sender, false);
    await sock.sendMessage(sender, {
      text: "❌ Não consegui processar o arquivo. Tente enviar novamente.",
    });
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

  await sendTyping(sender, false);
  await sock.sendMessage(sender, { text: `⏳ Enviando sua atividade para o ${platformLabel}...` });

  const result = await callApiMultipart(submitEndpoint, form);

  conversationState.delete(sender);

  await sendTyping(sender, false);
  if (result.ok) {
    await sock.sendMessage(sender, {
      text: `✅ Atividade *${selected.title}* entregue com sucesso no ${platformLabel}! 🎉`,
    });
  } else {
    await sock.sendMessage(sender, {
      text: `❌ Falha ao enviar: ${result.error || "Erro desconhecido."}`,
    });
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

  // ── In-progress conversation states take absolute priority ────────
  const state = conversationState.get(sender);

  if (state?.step === "AWAITING_ACTIVITY_NUMBER") {
    await handleActivityNumberInput(sender, text, state);
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
      await sendTyping(sender, false);
      await sock.sendMessage(sender, {
        text: "📎 Por favor, envie o arquivo da atividade.",
      });
    }
    return;
  }

  // ── Skip classification if no text (file sent outside of a flow) ─
  if (!text) {
    await sendTyping(sender, false);
    await sock.sendMessage(sender, {
      text: "Olá! 👋 Sou seu assistente acadêmico. Envie uma mensagem de texto para começarmos!",
    });
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
    aiResult = await classifyWithGemini(text, {}, sender);
    finalIntent = aiResult.intent;
    chatResponse = aiResult.chatResponse;
    platform = aiResult.platform || deterministic.platform;

    if (aiResult.requiresPlatformChoice || finalIntent === "AMBIGUOUS_PLATFORM") {
      await sendTyping(sender, false);
      await sock.sendMessage(sender, { text: chatResponse });
      return;
    }
  }

  // ── Route to the correct action ───────────────────────────────────

  switch (finalIntent) {

    case "GREETING":
      await sendTyping(sender, false);
      await sock.sendMessage(sender, {
        text: chatResponse ||
          "Olá! 👋 Sou seu assistente acadêmico pessoal. Estou aqui para te ajudar com suas atividades, prazos e muito mais!\n\n" +
          "Você pode me pedir coisas como:\n" +
          "• *atividades ava* — ver suas tarefas no AVA\n" +
          "• *atividades google* — ver suas tarefas no Google Classroom\n" +
          "• *entregar atividade ava* — entregar uma atividade no AVA\n" +
          "• *ava* ou *google* — conectar suas contas\n\n" +
          "Como posso te ajudar hoje? 😊",
      });
      break;

    case "CONNECT_GOOGLE": {
      try {
        const statusData = await callApi(
          `/auth/status?whatsappNumber=${encodeURIComponent(sender)}`
        );
        if (statusData.googleConnected) {
          await sendTyping(sender, false);
          await sock.sendMessage(sender, { text: "✅ Você já está conectado ao Google Classroom!" });
          return;
        }
        const data = await callApi(
          `/auth/google/start?whatsappNumber=${encodeURIComponent(sender)}`
        );
        await sendTyping(sender, false);
        if (data.authUrl) {
          await sock.sendMessage(sender, {
            text: `🔗 Clique no link abaixo para conectar sua conta do Google Classroom:\n\n${data.authUrl}`,
          });
        } else {
          await sock.sendMessage(sender, {
            text: "❌ Não foi possível gerar o link de autenticação. Tente novamente.",
          });
        }
      } catch (error) {
        console.error("[WhatsApp] Error fetching Google auth URL:", error.message);
        await sendTyping(sender, false);
        await sock.sendMessage(sender, {
          text: "❌ Erro ao conectar com o serviço. Tente novamente em instantes.",
        });
      }
      break;
    }

    case "CONNECT_AVA": {
      try {
        const statusData = await callApi(
          `/auth/status?whatsappNumber=${encodeURIComponent(sender)}`
        );
        if (statusData.avaConnected) {
          await sendTyping(sender, false);
          await sock.sendMessage(sender, { text: "✅ Você já está conectado ao AVA!" });
          return;
        }
        const data = await callApi(
          `/auth/ava/start?whatsappNumber=${encodeURIComponent(sender)}`
        );
        await sendTyping(sender, false);
        if (data.formUrl) {
          await sock.sendMessage(sender, {
            text:
              `🎓 Clique no link abaixo para conectar sua conta do AVA (Moodle):\n\n${data.formUrl}\n\n` +
              `_Insira seu usuário e senha do AVA no formulário que vai abrir._`,
          });
        } else {
          await sock.sendMessage(sender, {
            text: "❌ Não foi possível gerar o link de acesso ao AVA. Tente novamente.",
          });
        }
      } catch (error) {
        console.error("[WhatsApp] Error fetching AVA login URL:", error.message);
        await sendTyping(sender, false);
        await sock.sendMessage(sender, {
          text: "❌ Erro ao conectar com o serviço. Tente novamente em instantes.",
        });
      }
      break;
    }

    case "LIST_GOOGLE_ACTIVITIES": {
      try {
        const data = await callApi(
          `/classroom/activities?whatsappNumber=${encodeURIComponent(sender)}`
        );
        await sendTyping(sender, false);
        if (data.error) {
          await sock.sendMessage(sender, { text: `⚠️ ${data.error}` });
          return;
        }
        if (!data.activities || data.activities.length === 0) {
          await sock.sendMessage(sender, { text: "📭 Não há atividades no Google Classroom." });
          return;
        }
        const lines = data.activities.map((a) => `📚 ${a.courseName} - ${a.title} - ${a.link}`);
        await sock.sendMessage(sender, {
          text: `📋 *Suas atividades no Google Classroom:*\n\n${lines.join("\n")}`,
        });
      } catch (error) {
        console.error("[WhatsApp] Error fetching Google activities:", error.message);
        await sendTyping(sender, false);
        await sock.sendMessage(sender, {
          text: "❌ Erro ao buscar atividades. Tente novamente em instantes.",
        });
      }
      break;
    }

    case "LIST_AVA_ACTIVITIES": {
      try {
        const data = await callApi(
          `/ava/activities?whatsappNumber=${encodeURIComponent(sender)}`
        );
        await sendTyping(sender, false);
        if (data.error) {
          await sock.sendMessage(sender, { text: `⚠️ ${data.error}` });
          return;
        }
        if (!data.activities || data.activities.length === 0) {
          await sock.sendMessage(sender, { text: "📭 Não há atividades no AVA." });
          return;
        }
        const lines = data.activities.map((a) => `📚 ${a.courseName} - ${a.title}`);
        await sock.sendMessage(sender, {
          text: `📋 *Suas atividades no AVA:*\n\n${lines.join("\n")}`,
        });
      } catch (error) {
        console.error("[WhatsApp] Error fetching AVA activities:", error.message);
        await sendTyping(sender, false);
        await sock.sendMessage(sender, {
          text: "❌ Erro ao buscar atividades do AVA. Tente novamente em instantes.",
        });
      }
      break;
    }

    case "LIST_ACTIVITIES": {
      await sendTyping(sender, false);
      await sock.sendMessage(sender, {
        text: chatResponse ||
          "📚 Ótimo, vou buscar suas atividades! Mas me diz: você quer ver as atividades do *Google Classroom* ou do *AVA*?",
      });
      break;
    }

    case "SUBMIT_AVA": {
      await handleDeliverActivityStart(sender, "ava");
      break;
    }

    case "SUBMIT_GOOGLE": {
      await sendTyping(sender, false);
      await sock.sendMessage(sender, {
        text:
          "⏳ A entrega de atividades pelo Google Classroom ainda não está disponível.\n\n" +
          "Estamos trabalhando nessa funcionalidade e em breve você poderá entregar suas atividades por aqui. Fique atento às novidades! 🚀",
      });
      break;
    }

    case "SUBMIT_ACTIVITY": {
      await sendTyping(sender, false);
      await sock.sendMessage(sender, {
        text: chatResponse ||
          "📬 Para entregar uma atividade, especifique a plataforma:\n\n" +
          "• Digite *entregar atividade ava* para entregar no AVA (Moodle)\n" +
          "• Digite *entregar atividade google* para entregar no Google Classroom",
      });
      break;
    }

    case "CHAT":
    default: {
      if (chatResponse) {
        await sendTyping(sender, false);
        await sock.sendMessage(sender, { text: chatResponse });

      } else {
        await sendTyping(sender, false);
        await sock.sendMessage(sender, {
          text:
            "Hmm, não entendi muito bem. 🤔 Sou seu assistente acadêmico — " +
            "posso te ajudar com atividades, prazos e entregas!\n\n" +
            "Tente perguntar algo como *atividades ava* ou *entregar atividade ava*. 😊",
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
