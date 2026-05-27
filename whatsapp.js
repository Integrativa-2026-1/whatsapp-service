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

// ── MESSAGE HANDLERS ──────────────────────────────────────────────────

async function handleDeliverActivityStart(sender) {
  const data = await callApi(
    `/ava/activities?whatsappNumber=${encodeURIComponent(sender)}`
  );

  if (data.error) {
    await sock.sendMessage(sender, { text: `⚠️ ${data.error}` });
    return;
  }

  if (!data.activities || data.activities.length === 0) {
    await sock.sendMessage(sender, {
      text: "📭 Não há atividades disponíveis no AVA para entrega.",
    });
    return;
  }

  conversationState.set(sender, {
    step: "AWAITING_ACTIVITY_NUMBER",
    activities: data.activities,
    selectedActivity: null,
  });

  const lines = data.activities.map(
    (a, i) => `${i + 1} - ${a.title} — ${a.courseName}`
  );

  await sock.sendMessage(sender, {
    text: `📋 *Digite o número da atividade:*\n\n${lines.join("\n")}`,
  });
}

async function handleActivityNumberInput(sender, text, state) {
  const index = parseInt(text.trim(), 10) - 1;

  if (isNaN(index) || index < 0 || index >= state.activities.length) {
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

  await sock.sendMessage(sender, {
    text: `📎 Atividade selecionada: *${selected.title}*\n\nMande o arquivo da atividade.`,
  });
}

async function handleFileSubmission(sender, msg, state) {
  const selected = state.selectedActivity;

  const fileType =
    msg.message.documentMessage ||
    msg.message.documentWithCaptionMessage?.message?.documentMessage ||
    msg.message.imageMessage ||
    msg.message.videoMessage ||
    msg.message.audioMessage ||
    null;

  if (!fileType) {
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

  await sock.sendMessage(sender, { text: "⏳ Enviando sua atividade para o AVA..." });

  const result = await callApiMultipart("/ava/submit", form);

  conversationState.delete(sender);

  if (result.ok) {
    await sock.sendMessage(sender, {
      text: `✅ Atividade *${selected.title}* entregue com sucesso no AVA! 🎉`,
    });
  } else {
    await sock.sendMessage(sender, {
      text: `❌ Falha ao enviar: ${result.error || "Erro desconhecido."}`,
    });
  }
}

// ── MAIN MESSAGE ROUTER ───────────────────────────────────────────────

async function handleMessage(sock, sender, msg) {
  const text =
    msg.message?.conversation?.trim() ||
    msg.message?.extendedTextMessage?.text?.trim() ||
    "";

  const normalizedText = text.toLowerCase();
  const state = conversationState.get(sender);

  // ── Handle in-progress conversation states first ──────────────────

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
      await sock.sendMessage(sender, {
        text: "📎 Por favor, envie o arquivo da atividade.",
      });
    }
    return;
  }

  // ── Fresh commands ────────────────────────────────────────────────

  if (normalizedText === "entregar atividade") {
    await handleDeliverActivityStart(sender);
    return;
  }

  if (normalizedText === "google") {
    try {
      const data = await callApi(
        `/auth/google/start?whatsappNumber=${encodeURIComponent(sender)}`
      );
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
      await sock.sendMessage(sender, {
        text: "❌ Erro ao conectar com o serviço. Tente novamente em instantes.",
      });
    }
    return;
  }

  // ── AVA AUTH FLOW ─────────────────────────────────────────────────
  if (normalizedText === "ava") {
    try {
      const data = await callApi(
        `/auth/ava/start?whatsappNumber=${encodeURIComponent(sender)}`
      );

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
      await sock.sendMessage(sender, {
        text: "❌ Erro ao conectar com o serviço. Tente novamente em instantes.",
      });
    }
    return;
  }

  // ── LIST AVA ACTIVITIES ───────────────────────────────────────────
  if (normalizedText === "atividades ava") {
    try {
      const data = await callApi(
        `/ava/activities?whatsappNumber=${encodeURIComponent(sender)}`
      );

      if (data.error) {
        await sock.sendMessage(sender, { text: `⚠️ ${data.error}` });
        return;
      }

      if (!data.activities || data.activities.length === 0) {
        await sock.sendMessage(sender, { text: "📭 Não há atividades no AVA." });
        return;
      }

      const lines = data.activities.map(
        (a) => `📚 ${a.courseName} - ${a.title}`
      );

      await sock.sendMessage(sender, {
        text: `📋 *Suas atividades no AVA:*\n\n${lines.join("\n")}`,
      });
    } catch (error) {
      console.error("[WhatsApp] Error fetching AVA activities:", error.message);
      await sock.sendMessage(sender, {
        text: "❌ Erro ao buscar atividades do AVA. Tente novamente em instantes.",
      });
    }
    return;
  }

  if (normalizedText === "atividades google") {
    try {
      const data = await callApi(
        `/classroom/activities?whatsappNumber=${encodeURIComponent(sender)}`
      );

      if (data.error) {
        await sock.sendMessage(sender, { text: `⚠️ ${data.error}` });
        return;
      }

      if (!data.activities || data.activities.length === 0) {
        await sock.sendMessage(sender, { text: "📭 Não há atividades." });
        return;
      }

      const lines = data.activities.map(
        (a) => `📚 ${a.courseName} - ${a.title} - ${a.link}`
      );

      await sock.sendMessage(sender, {
        text: `📋 *Suas atividades no Google Classroom:*\n\n${lines.join("\n")}`,
      });
    } catch (error) {
      console.error("[WhatsApp] Error fetching activities:", error.message);
      await sock.sendMessage(sender, {
        text: "❌ Erro ao buscar atividades. Tente novamente em instantes.",
      });
    }
    return;
  }

  // ── Default response ──────────────────────────────────────────────
  await sock.sendMessage(sender, {
    text: "Olá, ainda estou em desenvolvimento! 🚀",
  });
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
