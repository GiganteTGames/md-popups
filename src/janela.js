const vscode = require("vscode");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");

const LISTA = "__lista__";

let estado = null;
const janelas = new Map();

function escapeHtml(texto) {
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cor(valor, padrao) {
  const v = String(valor == null ? "" : valor).trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  if (/^[a-z0-9(),.%\s+-]+$/i.test(v) && v.length < 60) return v;
  return padrao;
}

function cores() {
  const tipo = vscode.window.activeColorTheme ? vscode.window.activeColorTheme.kind : 2;
  const escuro = tipo === 2 || tipo === 4;
  let custom = {};
  try {
    custom = vscode.workspace.getConfiguration("workbench").get("colorCustomizations") || {};
  } catch (e) {
    custom = {};
  }
  const fundo = cor(custom["editor.background"], escuro ? "#1f1f1f" : "#ffffff");
  const texto = cor(custom["editor.foreground"], escuro ? "#cdcdcd" : "#333333");
  return {
    escuro,
    fundo,
    texto,
    link: cor(custom["textLink.foreground"], escuro ? "#4daafc" : "#006ab1"),
    borda: cor(custom["panel.border"], escuro ? "#2b2b2b" : "#e3e3e3"),
    codigo: cor(custom["textCodeBlock-background"], escuro ? "#2a2a2a" : "#f4f4f4"),
    citaBorda: cor(custom["textBlockQuote-border"], escuro ? "#4d4d4d" : "#dddddd"),
    citaFundo: cor(custom["textBlockQuote-background"], escuro ? "#262626" : "#f8f8f8"),
    citaTexto: cor(custom["textBlockQuote-foreground"], texto),
    selecao: cor(custom["editor.selectionBackground"], escuro ? "#264f78" : "#add6ff"),
    realce: cor(custom["list.hoverBackground"], escuro ? "#2a2d2e" : "#f0f0f0"),
    ativo: cor(custom["list.activeSelectionBackground"], escuro ? "#04395e" : "#cde4ff"),
  };
}

function relativo(uri) {
  return vscode.workspace.asRelativePath(uri, false);
}

function uriVscode(abs) {
  const norm = String(abs).replace(/\\/g, "/");
  return (
    "vscode://file/" +
    norm
      .split("/")
      .map((parte) => encodeURIComponent(parte).replace(/%3a/gi, ":"))
      .join("/")
  );
}

function resolver(dir, valor) {
  let v = valor;
  if (/^file:\/\//i.test(v)) {
    try {
      v = vscode.Uri.parse(v).fsPath;
    } catch (e) {
      return v;
    }
  }
  try {
    v = decodeURIComponent(v);
  } catch (e) {}
  return path.isAbsolute(v) ? path.normalize(v) : path.resolve(dir, v);
}

function reescreverLinks(html, dir) {
  const token = estado ? estado.token : "";
  return html
    .replace(/ src="([^"]*)"/g, (m, v) => {
      if (!v || /^(https?:|data:|blob:|vscode:)/i.test(v)) return m;
      const abs = resolver(dir, v);
      return ` src="/arquivo?p=${encodeURIComponent(abs)}&amp;t=${token}"`;
    })
    .replace(/ href="([^"]*)"/g, (m, v) => {
      if (!v || v[0] === "#" || /^(https?:|mailto:|data:|vscode:)/i.test(v)) return m;
      const partes = v.split("#");
      const abs = resolver(dir, partes[0]);
      const ancora = partes.length > 1 ? "#" + partes.slice(1).join("#").replace(/"/g, "") : "";
      return ` href="${uriVscode(abs)}${ancora}"`;
    })
    .replace(/<a href="https?:\/\/[^"]*"/g, (m) =>
      /target=/i.test(m) ? m : m + ' target="_blank" rel="noopener"'
    );
}

async function montarConteudo(uri) {
  const stat = await vscode.workspace.fs.stat(uri);
  const dados = await vscode.workspace.fs.readFile(uri);
  const markdown = Buffer.from(dados).toString("utf8");
  let artigo;
  try {
    artigo = await vscode.commands.executeCommand("markdown.api.render", markdown);
  } catch (e) {
    artigo = "<pre>" + escapeHtml(markdown) + "</pre>";
  }
  return {
    html: reescreverLinks(artigo, path.dirname(uri.fsPath)),
    mtime: stat.mtime,
    nome: path.basename(uri.fsPath),
    caminho: relativo(uri),
  };
}

async function listarArquivos() {
  const bruto = await vscode.workspace.findFiles(
    "**/*.md",
    "**/{node_modules,.git,dist,build,out}/**"
  );
  const vistos = new Set();
  const itens = [];
  for (const uri of bruto) {
    if (!/\.md$/i.test(uri.fsPath)) continue;
    if (vistos.has(uri.fsPath)) continue;
    vistos.add(uri.fsPath);
    itens.push({
      p: uri.fsPath,
      nome: path.basename(uri.fsPath),
      caminho: relativo(uri),
    });
  }
  itens.sort((a, b) => a.caminho.localeCompare(b.caminho));
  return itens;
}

async function servidorAtivo() {
  if (estado) return estado;
  const token = crypto.randomBytes(18).toString("hex");
  const novo = { token, porta: 0, server: null };
  novo.server = http.createServer(tratar);
  novo.server.on("error", () => {
    if (estado === novo) estado = null;
  });
  await new Promise((ok, erro) => {
    novo.server.once("error", erro);
    novo.server.listen(0, "127.0.0.1", () => {
      novo.porta = novo.server.address().port;
      ok();
    });
  });
  estado = novo;
  return novo;
}

function pararServidor() {
  if (!estado) return;
  const atual = estado;
  estado = null;
  try {
    if (atual.server.closeAllConnections) atual.server.closeAllConnections();
    atual.server.close();
  } catch (e) {}
}

async function tratar(req, res) {
  let url;
  try {
    url = new URL(req.url, "http://127.0.0.1");
  } catch (e) {
    res.writeHead(400);
    res.end();
    return;
  }
  if (!estado || url.searchParams.get("t") !== estado.token) {
    res.writeHead(403);
    res.end("Proibido");
    return;
  }
  try {
    if (req.method === "GET" && url.pathname === "/") return enviarDocumento(url, res);
    if (req.method === "GET" && url.pathname === "/pagina") return enviarPagina(url, res);
    if (req.method === "GET" && url.pathname === "/icone") return enviarIcone(res);
    if (req.method === "GET" && url.pathname === "/arquivo") return enviarArquivo(url, res);
    if (req.method === "POST" && url.pathname === "/fechar") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      const chave = url.searchParams.get("k");
      setTimeout(() => encerrarJanela(chave), 80);
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (e) {
    res.writeHead(500);
    res.end(String((e && e.message) || e));
  }
}

async function enviarDocumento(url, res) {
  const chave = url.searchParams.get("k") || LISTA;
  const alvo = url.searchParams.get("p");
  const html = alvo
    ? await montarDocumento(alvo, chave)
    : await montarLista(chave);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

async function enviarPagina(url, res) {
  const uri = vscode.Uri.file(url.searchParams.get("p"));
  const stat = await vscode.workspace.fs.stat(uri);
  if (String(url.searchParams.get("m")) === String(stat.mtime)) {
    res.writeHead(304);
    res.end();
    return;
  }
  const conteudo = await montarConteudo(uri);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(conteudo));
}

const ICONE = path.join(__dirname, "..", "images", "icon.png");

function enviarIcone(res) {
  let dados;
  try {
    dados = fs.readFileSync(ICONE);
  } catch (e) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
  res.end(dados);
}

const TIPOS = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

async function enviarArquivo(url, res) {
  const alvo = vscode.Uri.file(url.searchParams.get("p"));
  const dados = await vscode.workspace.fs.readFile(alvo);
  const tipo = TIPOS[path.extname(alvo.fsPath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": tipo, "Cache-Control": "no-store" });
  res.end(Buffer.from(dados));
}

function estilos(c) {
  return `
  :root { color-scheme: ${c.escuro ? "dark" : "light"}; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif;
    font-size: 14px;
    color: ${c.texto};
    background: ${c.fundo};
    line-height: 1.6;
  }
  .topo {
    position: sticky;
    top: 0;
    z-index: 3;
    background: ${c.fundo};
    border-bottom: 1px solid ${c.borda};
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 14px;
  }
  header .titulo { font-weight: 600; white-space: nowrap; }
  header .logo {
    width: 19px;
    height: 19px;
    border-radius: 4px;
    display: block;
    flex: none;
  }
  header .caminho {
    flex: 1;
    min-width: 0;
    font-size: 0.85em;
    opacity: 0.65;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  header .acoes { display: flex; align-items: center; gap: 10px; white-space: nowrap; }
  header a, header button {
    color: ${c.link};
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  header a:hover, header button:hover { text-decoration: underline; }
  header .voltar { font-size: 16px; line-height: 1; }
  header .fechar { font-size: 15px; line-height: 1; }
  .barra { padding: 0 14px 10px; }
  .barra input {
    width: 100%;
    padding: 7px 10px;
    font: inherit;
    color: ${c.texto};
    background: ${c.codigo};
    border: 1px solid ${c.borda};
    border-radius: 5px;
    outline: none;
  }
  .barra input:focus { border-color: ${c.link}; }
  ul#lista { list-style: none; margin: 0; padding: 4px 6px 60px; }
  ul#lista li a {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 7px 10px;
    border-radius: 5px;
    color: ${c.texto};
    text-decoration: none;
    cursor: pointer;
  }
  ul#lista li a:hover { background: ${c.realce}; }
  ul#lista .nome { font-weight: 600; white-space: nowrap; }
  ul#lista .caminho {
    flex: 1;
    min-width: 0;
    font-size: 0.85em;
    opacity: 0.6;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #vazio { padding: 30px 24px; opacity: 0.7; display: none; }
  article { max-width: 920px; margin: 0 auto; padding: 18px 26px 70px; }
  a { color: ${c.link}; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.6em; }
  h1, h2 { border-bottom: 1px solid ${c.borda}; padding-bottom: 0.3em; }
  code {
    background: ${c.codigo};
    padding: 2px 5px;
    border-radius: 3px;
    font-family: "Cascadia Code", Consolas, "Courier New", monospace;
    font-size: 0.92em;
  }
  pre {
    background: ${c.codigo};
    padding: 14px;
    border-radius: 6px;
    overflow: auto;
    line-height: 1.5;
  }
  pre code { padding: 0; background: transparent; }
  blockquote {
    border-left: 4px solid ${c.citaBorda};
    background: ${c.citaFundo};
    color: ${c.citaTexto};
    margin: 0;
    padding: 4px 16px;
  }
  table { border-collapse: collapse; margin: 1em 0; }
  th, td { border: 1px solid ${c.borda}; padding: 6px 10px; }
  th { background: ${c.codigo}; }
  img, video { max-width: 100%; }
  hr { border: 0; border-top: 1px solid ${c.borda}; margin: 1.6em 0; }
  ul, ol { padding-left: 1.6em; }
  input[type="checkbox"] { margin-right: 6px; }
  ::selection { background: ${c.selecao}; }
  `;
}

function scriptBase(k) {
  return `
  var k = ${JSON.stringify(k)};
  var t = ${JSON.stringify(estado.token)};
  function fechar() {
    fetch("/fechar?t=" + t + "&k=" + encodeURIComponent(k), { method: "POST" })
      .catch(function () {})
      .then(function () { setTimeout(function () { window.close(); }, 60); });
  }
  `;
}

async function montarLista(k) {
  const c = cores();
  const itens = await listarArquivos();
  const linhas = itens
    .map((item) => {
      const busca = (item.nome + " " + item.caminho).toLowerCase();
      const href =
        "/?p=" +
        encodeURIComponent(item.p) +
        "&amp;k=" +
        encodeURIComponent(k) +
        "&amp;t=" +
        estado.token;
      return (
        `<li data-busca="${escapeHtml(busca)}">` +
        `<a href="${href}">` +
        `<span class="nome">${escapeHtml(item.nome)}</span>` +
        `<span class="caminho">${escapeHtml(item.caminho)}</span>` +
        `</a></li>`
      );
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MD Popups</title>
<link rel="icon" type="image/png" href="/icone?t=${estado.token}">
<style>${estilos(c)}</style>
</head>
<body>
<div class="topo">
  <header>
    <img class="logo" src="/icone?t=${estado.token}" alt="">
    <strong class="titulo">MD Popups</strong>
    <span class="caminho">arquivos .md do projeto</span>
    <span class="acoes">
      <span id="contagem">${itens.length} arquivos</span>
      <a href="#" data-acao="atualizar">Atualizar</a>
      <button type="button" class="fechar" data-acao="fechar" title="Fechar (Esc)">&#10005;</button>
    </span>
  </header>
  <div class="barra">
    <input id="filtro" type="search" autofocus autocomplete="off" spellcheck="false"
      placeholder="Filtrar por nome ou caminho  ·  Enter abre  ·  Esc fecha">
  </div>
</div>
<ul id="lista">${linhas}</ul>
<p id="vazio">Nenhum arquivo .md encontrado.</p>
<script>
  ${scriptBase(k)}
  var itens = Array.prototype.slice.call(document.querySelectorAll("#lista li"));
  var entrada = document.getElementById("filtro");
  var contagem = document.getElementById("contagem");
  var vazio = document.getElementById("vazio");
  var total = itens.length;

  function filtrar() {
    var q = entrada.value.trim().toLowerCase();
    var n = 0;
    for (var i = 0; i < itens.length; i++) {
      var ok = !q || itens[i].getAttribute("data-busca").indexOf(q) !== -1;
      itens[i].style.display = ok ? "" : "none";
      if (ok) n++;
    }
    contagem.textContent = q ? n + " de " + total : total + " arquivos";
    vazio.style.display = n === 0 ? "block" : "none";
  }

  function primeiroVisivel() {
    for (var i = 0; i < itens.length; i++) {
      if (itens[i].style.display !== "none") return itens[i];
    }
    return null;
  }

  entrada.addEventListener("input", filtrar);
  entrada.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      var alvo = primeiroVisivel();
      if (alvo) {
        e.preventDefault();
        alvo.querySelector("a").click();
      }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      var visiveis = itens.filter(function (li) { return li.style.display !== "none"; });
      var atual = visiveis.indexOf(document.activeElement && document.activeElement.closest("li"));
      var prox = e.key === "ArrowDown" ? atual + 1 : atual - 1;
      if (visiveis[prox]) {
        e.preventDefault();
        visiveis[prox].querySelector("a").focus();
      }
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (document.activeElement === entrada && entrada.value) {
      entrada.value = "";
      filtrar();
      return;
    }
    e.preventDefault();
    fechar();
  });

  document.addEventListener("click", function (e) {
    var alvo = e.target.closest("[data-acao]");
    if (!alvo) return;
    e.preventDefault();
    if (alvo.dataset.acao === "fechar") fechar();
    else if (alvo.dataset.acao === "atualizar") location.reload();
  });

  filtrar();
</script>
</body>
</html>`;
}

async function montarDocumento(fsPath, k) {
  const uri = vscode.Uri.file(fsPath);
  const conteudo = await montarConteudo(uri);
  const c = cores();
  const editar = uriVscode(uri.fsPath);
  const voltar = "/?k=" + encodeURIComponent(k) + "&t=" + estado.token;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(conteudo.nome)}</title>
<link rel="icon" type="image/png" href="/icone?t=${estado.token}">
<style>${estilos(c)}</style>
</head>
<body>
<div class="topo">
  <header>
    <a class="voltar" href="${voltar}" data-acao="voltar" title="Voltar à lista">&#8592;</a>
    <strong class="titulo">${escapeHtml(conteudo.nome)}</strong>
    <span class="caminho">${escapeHtml(conteudo.caminho)}</span>
    <span class="acoes">
      <a href="#" data-acao="recarregar">Atualizar</a>
      <a href="${escapeHtml(editar)}" data-acao="editar">Abrir no editor</a>
      <button type="button" class="fechar" data-acao="fechar" title="Fechar (Esc)">&#10005;</button>
    </span>
  </header>
</div>
<article>${conteudo.html}</article>
<script>
  ${scriptBase(k)}
  var p = ${JSON.stringify(uri.fsPath)};
  var mtime = ${Number(conteudo.mtime) || 0};

  function sincronizar(forcar) {
    if (forcar) mtime = 0;
    return fetch("/pagina?p=" + encodeURIComponent(p) + "&t=" + t + "&m=" + mtime)
      .then(function (r) {
        if (r.status === 304 || !r.ok) return null;
        return r.json();
      })
      .then(function (d) {
        if (!d) return;
        mtime = d.mtime;
        document.querySelector("article").innerHTML = d.html;
        document.querySelector("header .titulo").textContent = d.nome;
        document.querySelector("header .caminho").textContent = d.caminho;
      })
      .catch(function () {});
  }

  setInterval(function () { sincronizar(false); }, 1000);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); fechar(); }
  });

  document.addEventListener("click", function (e) {
    var alvo = e.target.closest("[data-acao]");
    if (!alvo) return;
    var acao = alvo.dataset.acao;
    if (acao === "editar" || acao === "voltar") return;
    e.preventDefault();
    if (acao === "fechar") fechar();
    else if (acao === "recarregar") sincronizar(true);
  });
</script>
</body>
</html>`;
}

function localizarNavegador() {
  if (process.platform !== "win32") return null;
  const base = [
    process.env.LOCALAPPDATA,
    process.env["ProgramFiles"],
    process.env["ProgramFiles(x86)"],
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ].filter(Boolean);
  const caminhos = [];
  for (const raiz of base) {
    caminhos.push(path.join(raiz, "Microsoft", "Edge", "Application", "msedge.exe"));
    caminhos.push(path.join(raiz, "Google", "Chrome", "Application", "chrome.exe"));
  }
  return caminhos.find((c) => fs.existsSync(c)) || null;
}

function encerrarJanela(chave) {
  if (!chave) chave = LISTA;
  const janela = janelas.get(chave);
  if (janela) {
    janelas.delete(chave);
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(janela.filho.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        janela.filho.kill();
      }
    } catch (e) {}
    limparPerfil(janela.perfil);
  }
  if (janelas.size === 0) pararServidor();
}

function limparPerfil(perfil) {
  if (!perfil) return;
  setTimeout(() => {
    try {
      fs.rmSync(perfil, { recursive: true, force: true });
    } catch (e) {}
  }, 400);
}

async function abrirJanela(chave, url) {
  const exe = localizarNavegador();
  if (exe) {
    try {
      const perfil = fs.mkdtempSync(path.join(os.tmpdir(), "md-popups-"));
      const filho = spawn(
        exe,
        [
          "--app=" + url,
          "--user-data-dir=" + perfil,
          "--window-size=1024,768",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
        ],
        { stdio: "ignore" }
      );
      filho.on("error", () => {
        if (janelas.get(chave) && janelas.get(chave).filho === filho) janelas.delete(chave);
        limparPerfil(perfil);
        vscode.env.openExternal(vscode.Uri.parse(url));
      });
      filho.on("close", () => {
        if (janelas.get(chave) && janelas.get(chave).filho === filho) {
          janelas.delete(chave);
          limparPerfil(perfil);
          if (janelas.size === 0) pararServidor();
        }
      });
      janelas.set(chave, { filho, perfil });
      return;
    } catch (e) {}
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

function urlPara(chave, extras) {
  const partes = ["t=" + estado.token, "k=" + encodeURIComponent(chave)];
  if (extras) partes.push(extras);
  return "http://127.0.0.1:" + estado.porta + "/?" + partes.join("&");
}

async function abrirPopUp(uri) {
  const chave = uri.fsPath;
  if (janelas.has(chave)) return;
  await servidorAtivo();
  await abrirJanela(chave, urlPara(chave, "p=" + encodeURIComponent(chave)));
}

async function abrirLista() {
  if (janelas.has(LISTA)) return;
  await servidorAtivo();
  await abrirJanela(LISTA, urlPara(LISTA));
}

function desligar() {
  for (const chave of Array.from(janelas.keys())) encerrarJanela(chave);
  pararServidor();
}

module.exports = { abrirPopUp, abrirLista, desligar, servidorAtivo, LISTA };
