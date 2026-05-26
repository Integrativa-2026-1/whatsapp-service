const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
require("dotenv").config();

const { startWhatsApp, disconnectWhatsApp, getLatestQrCode } = require("./whatsapp");
const { htmlQrCode, htmlQrUnavailable } = require("./pages");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/qr", async (req, res) => {
  const qr = getLatestQrCode();
  if (!qr) {
    return res.send(htmlQrUnavailable());
  }

  try {
    const qrDataUrl = await QRCode.toDataURL(qr);
    res.send(htmlQrCode(qrDataUrl));
  } catch (error) {
    console.error("[Server] Error generating QR Code image:", error.message);
    res.status(500).send("Internal error generating QR Code.");
  }
});

app.post("/disconnect", async (req, res) => {
  try {
    await disconnectWhatsApp();
    setTimeout(() => startWhatsApp(), 1000);
    res.json({
      ok: true,
      message: "Session terminated successfully! A new QR Code will be available at /qr in a few seconds.",
    });
  } catch (error) {
    console.error("[Server] Error disconnecting:", error.message);
    res.status(500).json({ ok: false, message: "Error disconnecting WhatsApp session." });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`[Server] Express server started on port ${PORT}`);
  console.log(`[Server] Access http://localhost:${PORT}/qr to scan the QR Code.`);

  startWhatsApp();
});
