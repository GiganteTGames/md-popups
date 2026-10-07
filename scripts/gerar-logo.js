const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const N = 256;
const S = 4;
const R = N * S;

const FONTE = {
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
};

function dentroRR(px, py, x0, y0, x1, y1, rtl, rtr, rbr, rbl) {
  const w = x1 - x0;
  const h = y1 - y0;
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const bx = w / 2;
  const by = h / 2;
  const dx = px - cx;
  const dy = py - cy;
  let r;
  if (dx < 0 && dy < 0) r = rtl;
  else if (dx >= 0 && dy < 0) r = rtr;
  else if (dx >= 0 && dy >= 0) r = rbr;
  else r = rbl;
  const qx = Math.abs(dx) - bx + r;
  const qy = Math.abs(dy) - by + r;
  const d =
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    r;
  return d <= 0;
}

function dentroCirculo(px, py, cx, cy, raio) {
  return (px - cx) ** 2 + (py - cy) ** 2 <= raio * raio;
}

function mesclar(buf, x, y, cor) {
  const i = (y * R + x) * 4;
  buf[i] = cor[0];
  buf[i + 1] = cor[1];
  buf[i + 2] = cor[2];
  buf[i + 3] = 255;
}

function mistura(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function desenhar() {
  const buf = Buffer.alloc(R * R * 4, 0);
  const corTopo = [47, 126, 240];
  const corBase = [132, 83, 240];
  const branco = [255, 255, 255];
  const cabecalho = [231, 236, 245];
  const texto = [17, 24, 39];

  const letras = "MD";
  const escala = 12;
  const largura = (5 * letras.length + (letras.length - 1)) * escala;
  const altura = 7 * escala;
  const corpo = { x0: 46, y0: 92, x1: 210, y1: 198 };
  const lx = Math.round(corpo.x0 + (corpo.x1 - corpo.x0 - largura) / 2);
  const ly = Math.round(corpo.y0 + (corpo.y1 - corpo.y0 - altura) / 2);

  const pontos = [
    { x: 62, y: 79, r: 5, c: [255, 95, 87] },
    { x: 80, y: 79, r: 5, c: [254, 188, 46] },
    { x: 98, y: 79, r: 5, c: [40, 200, 64] },
  ];

  for (let j = 0; j < R; j++) {
    const py = (j + 0.5) / S;
    for (let i = 0; i < R; i++) {
      const px = (i + 0.5) / S;
      let cor = null;

      if (dentroRR(px, py, 4, 4, 252, 252, 52, 52, 52, 52)) {
        const t = Math.min(1, Math.max(0, 0.3 * (px / N) + 0.7 * (py / N)));
        cor = mistura(corTopo, corBase, t);
      }
      if (cor && dentroRR(px, py, 46, 66, 210, 198, 16, 16, 16, 16)) {
        cor = cabecalho;
      }
      if (cor && dentroRR(px, py, 46, 92, 210, 198, 0, 0, 16, 16)) {
        cor = branco;
      }
      if (cor) {
        for (const p of pontos) {
          if (dentroCirculo(px, py, p.x, p.y, p.r)) {
            cor = p.c;
            break;
          }
        }
      }
      if (cor === branco) {
        for (let n = 0; n < letras.length; n++) {
          const glifo = FONTE[letras[n]];
          for (let linha = 0; linha < glifo.length; linha++) {
            for (let col = 0; col < glifo[linha].length; col++) {
              if (glifo[linha][col] !== "1") continue;
              const rx = lx + (n * 6 + col) * escala;
              const ry = ly + linha * escala;
              if (px >= rx && px < rx + escala && py >= ry && py < ry + escala) {
                cor = texto;
                break;
              }
            }
            if (cor === texto) break;
          }
          if (cor === texto) break;
        }
      }

      if (cor) mesclar(buf, i, j, cor);
    }
  }
  return buf;
}

function reduzir(grande) {
  const saida = Buffer.alloc(N * N * 4, 0);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * R + (x * S + sx)) * 4;
          const alfa = grande[i + 3] / 255;
          r += grande[i] * alfa;
          g += grande[i + 1] * alfa;
          b += grande[i + 2] * alfa;
          a += grande[i + 3];
        }
      }
      const n = S * S;
      const o = (y * N + x) * 4;
      const alfaMedio = a / n;
      if (alfaMedio > 0) {
        const k = 255 / (a || 1);
        saida[o] = Math.round(r * k);
        saida[o + 1] = Math.round(g * k);
        saida[o + 2] = Math.round(b * k);
      }
      saida[o + 3] = Math.round(alfaMedio);
    }
  }
  return saida;
}

const TABELA = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABELA[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(tipo, dados) {
  const corpo = Buffer.concat([Buffer.from(tipo, "ascii"), dados]);
  const cabecalho = Buffer.alloc(4);
  cabecalho.writeUInt32BE(dados.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo), 0);
  return Buffer.concat([cabecalho, corpo, crc]);
}

function png(rgba) {
  const bruto = Buffer.alloc((N * 4 + 1) * N);
  for (let y = 0; y < N; y++) {
    bruto[y * (N * 4 + 1)] = 0;
    rgba.copy(bruto, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0);
  ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(bruto, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function prever(rgba) {
  const largura = 72;
  const altura = 36;
  const linhas = [];
  for (let y = 0; y < altura; y++) {
    let linha = "";
    for (let x = 0; x < largura; x++) {
      const px = Math.floor(((x + 0.5) / largura) * N);
      const py = Math.floor(((y + 0.5) / altura) * N);
      const i = (py * N + px) * 4;
      const a = rgba[i + 3] / 255;
      const l = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a + 255 * (1 - a);
      linha += l > 235 ? "." : l > 190 ? ":" : l > 140 ? "+" : l > 90 ? "*" : l > 45 ? "#" : "@";
    }
    linhas.push(linha);
  }
  console.log(linhas.join("\n"));
}

const saida = path.join(__dirname, "..", "images", "icon.png");
fs.mkdirSync(path.dirname(saida), { recursive: true });
const final = reduzir(desenhar());
fs.writeFileSync(saida, png(final));
console.log("logo gerado: " + saida + " (" + fs.statSync(saida).size + " bytes)");
if (process.argv.includes("--preview")) prever(final);
