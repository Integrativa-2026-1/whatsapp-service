function htmlQrCode(dataUrl) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Connect WhatsApp</title>
</head>
<body style="background:#0f172a;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;color:#fff;">
  <h1 style="margin-bottom: 1.5rem; font-size: 1.5rem;">Scan the QR Code to connect</h1>
  <div style="background:#fff; padding: 1.5rem; border-radius: 12px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3);">
    <img src="${dataUrl}" style="width:280px;height:280px;display:block;" />
  </div>
  <p style="margin-top: 1.5rem; color: #94a3b8; font-size: 0.9rem;">Open WhatsApp on your phone > Linked Devices > Link a Device</p>
</body>
</html>`;
}

function htmlQrUnavailable() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WhatsApp Connected</title>
</head>
<body style="background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;">
  <div style="text-align: center; padding: 2rem;">
    <p style="font-size: 1.2rem; margin-bottom: 0.5rem; color: #10b981; font-weight: bold;">WhatsApp Connected! 🎉</p>
    <p style="color:#94a3b8;">The bot is already active or the server is initializing the connection.</p>
  </div>
</body>
</html>`;
}

module.exports = {
  htmlQrCode,
  htmlQrUnavailable,
};
