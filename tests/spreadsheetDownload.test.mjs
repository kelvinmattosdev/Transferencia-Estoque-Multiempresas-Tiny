import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import xlsx from "xlsx";
import {
    PlanilhaDownloadInvalidaError,
    baixarPlanilhaComValidacao,
    validarPlanilhaInventario,
} from "../build/services/spreadsheetDownload.service.js";

function criarPlanilhaValida(destino, estoque = 2) {
    const worksheet = xlsx.utils.aoa_to_sheet([
        ["Produto", "Código (SKU)", "Preço", "UN", "Localização", "Estoque atual"],
        ["Produto teste", "SKU-1", 10, "UN", "A1", estoque],
    ]);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "Inventário de Estoque");
    xlsx.writeFile(workbook, destino, { bookType: "xls" });
}

function arquivoTemporario(nome) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-planilha-test-"));
    return { dir, arquivo: path.join(dir, nome) };
}

test("aceita arquivo Excel/XLS válido com a estrutura de inventário", () => {
    const { dir, arquivo } = arquivoTemporario("inventario.xls");
    try {
        criarPlanilhaValida(arquivo);
        const resultado = validarPlanilhaInventario(arquivo);
        assert.equal(resultado.aba, "Inventário de Estoque");
        assert.ok(resultado.tamanhoBytes > 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("rejeita arquivo vazio", () => {
    const { dir, arquivo } = arquivoTemporario("vazio.xls");
    try {
        fs.writeFileSync(arquivo, "");
        assert.throws(() => validarPlanilhaInventario(arquivo), PlanilhaDownloadInvalidaError);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("rejeita HTML sem tabela", () => {
    const { dir, arquivo } = arquivoTemporario("html.xls");
    try {
        fs.writeFileSync(arquivo, "<html><script>location.href='/login'</script></html>");
        assert.throws(() => validarPlanilhaInventario(arquivo), /HTML sem tabela/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("rejeita página de login ou erro salva como .xls", () => {
    const { dir, arquivo } = arquivoTemporario("login.xls");
    try {
        fs.writeFileSync(arquivo, "<!doctype html><html><body>Login Tiny: sessão expirada</body></html>");
        assert.throws(() => validarPlanilhaInventario(arquivo), PlanilhaDownloadInvalidaError);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("repete após a primeira tentativa inválida e aceita a segunda", async () => {
    const { dir, arquivo } = arquivoTemporario("inventario.xls");
    let tentativas = 0;
    try {
        const retorno = await baixarPlanilhaComValidacao({
            empresa: "SC",
            outputPath: arquivo,
            log: () => {},
            baixar: async () => {
                tentativas++;
                if (tentativas === 1) fs.writeFileSync(arquivo, "<script>login</script>");
                else criarPlanilhaValida(arquivo);
                return arquivo;
            },
        });
        assert.equal(retorno, arquivo);
        assert.equal(tentativas, 2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("aceita relatório válido com todos os estoques zerados e emite alerta sanitizado", async () => {
    const { dir, arquivo } = arquivoTemporario("inventario-zerado.xls");
    const logs = [];
    try {
        const retorno = await baixarPlanilhaComValidacao({
            empresa: "SC",
            outputPath: arquivo,
            log: (mensagem) => logs.push(mensagem),
            baixar: async () => {
                criarPlanilhaValida(arquivo, 0);
                return arquivo;
            },
        });
        assert.equal(retorno, arquivo);
        assert.ok(logs.some((mensagem) => /SC.*1 item.*todos os estoques zerados/i.test(mensagem)));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("após três falhas não executa movimentação de estoque", async () => {
    const { dir, arquivo } = arquivoTemporario("inventario.xls");
    let tentativas = 0;
    let movimentacoes = 0;
    try {
        try {
            await baixarPlanilhaComValidacao({
                empresa: "SC",
                outputPath: arquivo,
                log: () => {},
                baixar: async () => {
                    tentativas++;
                    fs.writeFileSync(arquivo, "<html>página de erro</html>");
                    return arquivo;
                },
            });
            movimentacoes++; // representa a primeira chamada de transferência do job
        } catch (erro) {
            assert.match(erro.message, /SC: a planilha não pôde ser obtida em formato válido após 3 tentativas/);
        }
        assert.equal(movimentacoes, 0);
        assert.equal(tentativas, 3);
        assert.equal(fs.existsSync(arquivo), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
