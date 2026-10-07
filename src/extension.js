const vscode = require("vscode");
const { abrirLista, abrirPopUp, desligar } = require("./janela");

function ativar(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("mdPopups.abrir", () => abrirLista()),
    vscode.commands.registerCommand("mdPopups.abrirArquivo", (uri) => abrirAlvo(uri)),
    vscode.commands.registerCommand("mdPopups.abrirEditor", (uri) => {
      const alvo =
        uri instanceof vscode.Uri
          ? uri
          : vscode.window.activeTextEditor?.document.uri;
      if (alvo) {
        vscode.window.showTextDocument(alvo, { preview: false });
      }
    }),
    { dispose: desligar }
  );

  if (deveAbrirAutomatico()) {
    const abrir = () => {
      abrirLista().catch(() => {});
    };
    setTimeout(abrir, 700);
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(abrir));
  }
}

function deveAbrirAutomatico() {
  if (!vscode.workspace.workspaceFolders?.length) return false;
  return vscode.workspace.getConfiguration("mdPopups").get("autoAbrir", true) !== false;
}

function abrirAlvo(uri) {
  const alvo = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
  if (alvo && /\.md$/i.test(alvo.fsPath || "")) {
    return abrirPopUp(alvo);
  }
  return abrirLista();
}

module.exports = { activate: ativar, deactivate: desligar };
