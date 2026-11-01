// Servidor de salas de "¿Por qué hiciste eso?".
// Reenvía mensajes entre los jugadores de cada sala (máximo 4).
// Usa el mismo protocolo que relay.gd: crear / unir / enviar -> sala / entro / salio / datos / error / cerrada.
const http = require("http");
const { WebSocketServer } = require("ws");

const PUERTO = process.env.PORT || 8910;
const LETRAS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_POR_SALA = 4;

const clientes = new Map(); // id -> { ws, sala, vivo }
const salas = new Map();    // codigo -> [ids], el primero es el anfitrión
let siguiente = 1;

const servidor = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Servidor de ¿Por qué hiciste eso? funcionando. Salas abiertas: ${salas.size}\n`);
});

const wss = new WebSocketServer({ server: servidor });

function enviar(id, m) {
  const c = clientes.get(id);
  if (c && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(m));
}

function codigoNuevo() {
  let c;
  do {
    c = "";
    for (let i = 0; i < 4; i++) c += LETRAS[Math.floor(Math.random() * LETRAS.length)];
  } while (salas.has(c));
  return c;
}

function mensaje(id, m) {
  const c = clientes.get(id);
  if (!c) return;
  switch (String(m.t || "")) {
    case "crear": {
      if (c.sala) return;
      const codigo = codigoNuevo();
      salas.set(codigo, [id]);
      c.sala = codigo;
      enviar(id, { t: "sala", codigo, id, host: true });
      break;
    }
    case "unir": {
      if (c.sala) return;
      const codigo = String(m.codigo || "").trim().toUpperCase();
      const sala = salas.get(codigo);
      if (!sala) return enviar(id, { t: "error", msg: `No existe la sala ${codigo}.` });
      if (sala.length >= MAX_POR_SALA) return enviar(id, { t: "error", msg: "La sala está llena." });
      sala.push(id);
      c.sala = codigo;
      enviar(id, { t: "sala", codigo, id, host: false });
      enviar(sala[0], { t: "entro", id });
      break;
    }
    case "enviar": {
      const sala = salas.get(c.sala);
      if (!sala) return;
      const para = Number(m.para || 0);
      const salida = { t: "datos", de: id, d: m.d || {} };
      if (para === 0) sala.forEach((otro) => otro !== id && enviar(otro, salida));
      else if (para === -1) enviar(sala[0], salida);
      else if (sala.includes(para)) enviar(para, salida);
      break;
    }
  }
}

function desconectar(id) {
  const c = clientes.get(id);
  if (!c) return;
  clientes.delete(id);
  const sala = salas.get(c.sala);
  if (!sala) return;
  if (sala[0] === id) {
    sala.forEach((otro) => otro !== id && enviar(otro, { t: "cerrada" }));
    salas.delete(c.sala);
  } else {
    sala.splice(sala.indexOf(id), 1);
    enviar(sala[0], { t: "salio", id });
  }
}

wss.on("connection", (ws) => {
  const id = siguiente++;
  clientes.set(id, { ws, sala: "", vivo: true });
  ws.on("pong", () => { const c = clientes.get(id); if (c) c.vivo = true; });
  ws.on("message", (datos) => {
    let m;
    try { m = JSON.parse(datos.toString()); } catch { return; }
    if (m && typeof m === "object") mensaje(id, m);
  });
  ws.on("close", () => desconectar(id));
  ws.on("error", () => desconectar(id));
});

// Revisa cada 20 s que los jugadores sigan conectados y mantiene viva la conexión.
setInterval(() => {
  for (const [id, c] of clientes) {
    if (!c.vivo) { c.ws.terminate(); desconectar(id); continue; }
    c.vivo = false;
    c.ws.ping();
  }
}, 20000);

servidor.listen(PUERTO, () => console.log(`Servidor de salas escuchando en el puerto ${PUERTO}`));
