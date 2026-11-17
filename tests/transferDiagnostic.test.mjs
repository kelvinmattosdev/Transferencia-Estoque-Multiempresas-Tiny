import assert from "node:assert/strict";
import test from "node:test";
import { construirDiagnosticoTransferencia } from "../build/services/transferDiagnostic.service.js";

test("constrói diagnóstico de transferência com dados de requisição permitidos e resposta sanitizada", () => {
    const diagnostic = construirDiagnosticoTransferencia({
        sku: "JP18937",
        saldoPlanilha: -34,
        consultasProduto: {
            master: {
                empresa: "JP",
                url: "https://api.tiny.com.br/public-api/v3/produtos?codigo=JP18937&situacao=A",
                produtoSelecionado: { id: 915671531, descricao: "Ventilador" },
            },
            filial: {
                empresa: "SC",
                url: "https://api.tiny.com.br/public-api/v3/produtos?codigo=JP18937&situacao=A",
                produtoSelecionado: { id: 915475587, descricao: "Ventilador" },
            },
        },
        depositos: {
            master: { empresa: "JP", valor: 785301556, origem: "JP_ID_DEPOSITO" },
            filial: { empresa: "SC", valor: 344534890, origem: "SC_ID_DEPOSITO" },
        },
        movimentacoes: [{
            etapa: "entrada_filial",
            empresa: "SC",
            url: "https://api.tiny.com.br/public-api/v3/estoque/915475587",
            body: { deposito: { id: 344534890 }, tipo: "E", quantidade: 34 },
            resultado: {
                status: 400,
                responseData: {
                    mensagem: "Ocorreram erros de validação",
                    detalhes: [{ campo: "deposito.id", mensagem: "Depósito não encontrado", token: "segredo" }],
                    access_token: "segredo",
                    html: "<html>não deve persistir</html>",
                },
            },
        }],
    });

    assert.equal(diagnostic.sku, "JP18937");
    assert.equal(diagnostic.origem_planilha.saldo, -34);
    assert.equal(diagnostic.consultas_produto.master.produto_selecionado.id, 915671531);
    assert.equal(diagnostic.depositos.filial.origem_variavel_env, "SC_ID_DEPOSITO");
    assert.deepEqual(diagnostic.movimentacoes[0].corpo_efetivo, {
        deposito: { id: 344534890 }, tipo: "E", quantidade: 34,
    });
    assert.deepEqual(diagnostic.movimentacoes[0].resultado.resposta, {
        mensagem: "Ocorreram erros de validação",
        detalhes: [{ campo: "deposito.id", mensagem: "Depósito não encontrado" }],
    });
    assert.equal(JSON.stringify(diagnostic).includes("segredo"), false);
    assert.equal(JSON.stringify(diagnostic).includes("<html>"), false);
});

test("limita textos de resposta da API", () => {
    const diagnostic = construirDiagnosticoTransferencia({
        sku: "JP1",
        saldoPlanilha: 1,
        consultasProduto: {},
        depositos: {},
        movimentacoes: [{
            etapa: "saida_master", empresa: "JP", url: "https://api.tiny.com.br/public-api/v3/estoque/1",
            body: {}, resultado: { status: 400, responseData: { mensagem: "x".repeat(1000) } },
        }],
    });
    assert.equal(diagnostic.movimentacoes[0].resultado.resposta.mensagem.length, 500);
});

test("normaliza e limita a descrição selecionada do produto", () => {
    const diagnostic = construirDiagnosticoTransferencia({
        sku: "JP1", saldoPlanilha: 1,
        consultasProduto: {
            master: {
                empresa: "JP", url: "https://api.tiny.com.br/public-api/v3/produtos?codigo=JP1&situacao=A",
                produtoSelecionado: { id: 1, descricao: `  Produto\n${"x".repeat(600)} ` },
            },
        },
        depositos: {}, movimentacoes: [],
    });
    const descricao = diagnostic.consultas_produto.master.produto_selecionado.descricao;
    assert.equal(descricao.length, 500);
    assert.equal(descricao.startsWith("Produto x"), true);
    assert.equal(descricao.includes("\n"), false);
});

test("mantém a etapa e a empresa de cada perna e o corpo POST efetivo", () => {
    const timestamp = "2026-09-22 13:44:55";
    const diagnostic = construirDiagnosticoTransferencia({
        sku: "JP1", saldoPlanilha: -2, consultasProduto: {}, depositos: {},
        movimentacoes: [
            { etapa: "saida_master", empresa: "JP", url: "https://api.tiny.com.br/public-api/v3/estoque/11", body: { data: timestamp, tipo: "S" }, resultado: { sucesso: true, status: 200 } },
            { etapa: "entrada_filial", empresa: "SC", url: "https://api.tiny.com.br/public-api/v3/estoque/22", body: { data: timestamp, tipo: "E" }, resultado: { sucesso: false, status: 400 } },
        ],
    });
    assert.deepEqual(diagnostic.movimentacoes.map((item) => [item.etapa, item.empresa]), [
        ["saida_master", "JP"], ["entrada_filial", "SC"],
    ]);
    assert.equal(diagnostic.movimentacoes[1].corpo_efetivo.data, timestamp);
});

test("resume lookup e redige texto sensível em respostas", () => {
    const diagnostic = construirDiagnosticoTransferencia({
        sku: "JP1", saldoPlanilha: 2,
        consultasProduto: {
            filial: {
                empresa: "SC", url: "https://api.tiny.com.br/public-api/v3/produtos?codigo=JP1&situacao=A",
                resultado: { sucesso: false, status: 400, responseData: {
                    mensagem: "token=super-secreto; senha meu-segredo; Bearer abc.def",
                    detalhes: [{ campo: "codigo", mensagem: "access_token: nao-vazar" }],
                } },
            },
        }, depositos: {}, movimentacoes: [],
    });
    const lookup = diagnostic.consultas_produto.filial;
    assert.equal(lookup.resultado.status, 400);
    assert.equal(lookup.resultado.sucesso, false);
    const serializado = JSON.stringify(diagnostic);
    assert.equal(serializado.includes("super-secreto"), false);
    assert.equal(serializado.includes("meu-segredo"), false);
    assert.equal(serializado.includes("abc.def"), false);
    assert.equal(serializado.includes("nao-vazar"), false);
});

test("informa a origem segura do token e preserva a sequência de tentativas POST", () => {
    const diagnostic = construirDiagnosticoTransferencia({
        sku: "JP1", saldoPlanilha: -2, consultasProduto: {}, depositos: {},
        autenticacao: {
            master: { empresa: "JP", origem: "JP_TOKEN_SOURCE", fonte: "db" },
            filial: { empresa: "SC", origem: "SC_TOKEN_SOURCE", fonte: "env" },
        },
        movimentacoes: [
            { etapa: "entrada_filial", empresa: "SC", tentativa: 1, url: "https://api.tiny.com.br/public-api/v3/estoque/2", body: { data: "2026-09-22 11:00:00" }, resultado: { sucesso: false, status: 401, responseData: { mensagem: "não autorizado" } } },
            { etapa: "entrada_filial", empresa: "SC", tentativa: 2, url: "https://api.tiny.com.br/public-api/v3/estoque/2", body: { data: "2026-09-22 11:00:01" }, resultado: { sucesso: true, status: 201, responseData: { idLancamento: 99 } } },
        ],
    });
    assert.deepEqual(diagnostic.autenticacao.master, { empresa: "JP", origem_variavel_env: "JP_TOKEN_SOURCE", fonte: "db" });
    assert.deepEqual(diagnostic.movimentacoes.map(({ tentativa, resultado }) => [tentativa, resultado.status, resultado.sucesso]), [
        [1, 401, false], [2, 201, true],
    ]);
});

test("atribui uma falha de POST da master à etapa e empresa master", () => {
    const diagnostic = construirDiagnosticoTransferencia({
        sku: "JP1", saldoPlanilha: -1, consultasProduto: {}, depositos: {},
        movimentacoes: [{
            etapa: "saida_master", empresa: "JP", tentativa: 1,
            url: "https://api.tiny.com.br/public-api/v3/estoque/1", body: {},
            resultado: { sucesso: false, status: 400, responseData: { mensagem: "Depósito não encontrado" } },
        }],
    });
    assert.equal(diagnostic.movimentacoes[0].etapa, "saida_master");
    assert.equal(diagnostic.movimentacoes[0].empresa, "JP");
});
