// Servidor de salas de "¿Por qué hiciste eso?".
// Reenvía mensajes entre los jugadores de cada sala (máximo 4).
// Protocolo: crear / unir / volver / enviar -> sala / entro / salio / datos / error / cerrada.
// Si alguien pierde la conexión (por ejemplo, salió a WhatsApp a compartir el código),
// su lugar se guarda un rato para que pueda volver a la misma sala.
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PUERTO = process.env.PORT || 8910;
const LETRAS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_POR_SALA = 4;
// Segundos que se guarda el lugar de quien se desconectó sin querer.
const GRACIA_SEGUNDOS = 180;

const clientes = new Map(); // id -> { ws, sala, vivo, clave, temporizador }
const salas = new Map();    // codigo -> [ids], el primero es el anfitrión
let siguiente = 1;

const servidor = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Servidor de ¿Por qué hiciste eso? funcionando. Salas abiertas: ${salas.size}\n`);
});

const wss = new WebSocketServer({ server: servidor });

// Mensajes que se guardan mientras alguien está desconectado (por ejemplo, "entró un amigo").
const MAX_PENDIENTES = 300;

function enviar(id, m) {
  const c = clientes.get(id);
  if (!c) return;
  if (c.ws && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(m));
  else if (c.sala) {
    // Los "datos" del juego se reemplazan solos; los avisos de la sala sí se guardan.
    if (m.t === "datos" && m.d && m.d.t === "estado") return;
    c.pendientes.push(m);
    if (c.pendientes.length > MAX_PENDIENTES) c.pendientes.shift();
  }
}

function codigoNuevo() {
  let c;
  do {
    c = "";
    for (let i = 0; i < 4; i++) c += LETRAS[Math.floor(Math.random() * LETRAS.length)];
  } while (salas.has(c));
  return c;
}

function claveNueva() {
  return crypto.randomBytes(12).toString("hex");
}

function mensaje(ctx, m) {
  const id = ctx.id;
  const c = clientes.get(id);
  if (!c) return;
  switch (String(m.t || "")) {
    case "crear": {
      if (c.sala) return;
      const codigo = codigoNuevo();
      salas.set(codigo, [id]);
      c.sala = codigo;
      enviar(id, { t: "sala", codigo, id, host: true, clave: c.clave });
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
      enviar(id, { t: "sala", codigo, id, host: false, clave: c.clave });
      enviar(sala[0], { t: "entro", id });
      break;
    }
    case "volver": {
      // Regresa a su lugar en la sala con la misma identidad.
      if (c.sala) return;
      const viejoId = Number(m.id || 0);
      const viejo = clientes.get(viejoId);
      const codigo = String(m.codigo || "").trim().toUpperCase();
      if (!viejo || viejo.clave !== String(m.clave || "") || viejo.sala !== codigo || !salas.has(codigo)) {
        return enviar(id, { t: "error", msg: "La sala ya se cerró." });
      }
      if (viejo.temporizador) clearTimeout(viejo.temporizador);
      viejo.temporizador = null;
      if (viejo.ws && viejo.ws !== c.ws) { try { viejo.ws.terminate(); } catch {} }
      viejo.ws = c.ws;
      viejo.vivo = true;
      clientes.delete(id);
      ctx.id = viejoId;
      const sala = salas.get(codigo);
      enviar(viejoId, { t: "sala", codigo, id: viejoId, host: sala[0] === viejoId, clave: viejo.clave, volvio: true, miembros: sala.slice() });
      const pendientes = viejo.pendientes;
      viejo.pendientes = [];
      pendientes.forEach((p) => enviar(viejoId, p));
      break;
    }
    case "salir": {
      // Salida a propósito: se cierra de inmediato, sin esperar.
      quitar(id);
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

// Saca al jugador de su sala para siempre.
function quitar(id) {
  const c = clientes.get(id);
  if (!c) return;
  if (c.temporizador) clearTimeout(c.temporizador);
  clientes.delete(id);
  const sala = salas.get(c.sala);
  if (!sala) return;
  if (sala[0] === id) {
    sala.forEach((otro) => otro !== id && enviar(otro, { t: "cerrada" }));
    sala.forEach((otro) => { const o = clientes.get(otro); if (o) o.sala = ""; });
    salas.delete(c.sala);
  } else {
    sala.splice(sala.indexOf(id), 1);
    enviar(sala[0], { t: "salio", id });
  }
}

// Se cortó la conexión: si estaba en una sala, le guardamos el lugar un rato.
function desconectar(id, ws, aPropósito) {
  const c = clientes.get(id);
  if (!c || c.ws !== ws) return; // ya volvió con otra conexión
  if (aPropósito || !c.sala || !salas.has(c.sala)) return quitar(id);
  c.ws = null;
  if (c.temporizador) clearTimeout(c.temporizador);
  c.temporizador = setTimeout(() => quitar(id), GRACIA_SEGUNDOS * 1000);
}

wss.on("connection", (ws) => {
  const ctx = { id: siguiente++ };
  clientes.set(ctx.id, { ws, sala: "", vivo: true, clave: claveNueva(), temporizador: null, pendientes: [] });
  ws.on("pong", () => { const c = clientes.get(ctx.id); if (c && c.ws === ws) c.vivo = true; });
  ws.on("message", (datos) => {
    let m;
    try { m = JSON.parse(datos.toString()); } catch { return; }
    if (m && typeof m === "object") mensaje(ctx, m);
  });
  // 1000 = el juego cerró la conexión a propósito (botón Salir).
  ws.on("close", (codigo) => desconectar(ctx.id, ws, codigo === 1000));
  ws.on("error", () => desconectar(ctx.id, ws, false));
});

// Revisa cada 20 s que los jugadores sigan conectados y mantiene viva la conexión.
setInterval(() => {
  for (const [id, c] of clientes) {
    if (!c.ws) continue;
    if (!c.vivo) { const ws = c.ws; ws.terminate(); desconectar(id, ws, false); continue; }
    c.vivo = false;
    c.ws.ping();
  }
}, 20000);

servidor.listen(PUERTO, () => console.log(`Servidor de salas escuchando en el puerto ${PUERTO}`));
