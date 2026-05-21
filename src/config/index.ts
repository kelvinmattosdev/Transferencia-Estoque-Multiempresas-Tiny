// ###  ./src/config/index.ts  ###
// Esse script lê o .env (via process.env) e exporta funções utilitárias de validação/config

import { conectarAoBanco } from "../services/database.service.js";
import { getEstoqueProdTiny } from "../services/tinyApi.service.js";
import { listaEmpresasDefinidas, listaTelefones, instanceWhatsApp, sendMessageMain } from "../main.js";
import { buildHistoryDbConfig } from "./historyDb.config.js";
import {
    finalizarRelatorioHomologacao,
    registrarProblemaHomologacao,
} from "../services/homologacaoReport.service.js";

export const historyDbConfig = buildHistoryDbConfig();

function registrarErroValidacaoConfig(mensagem: string, dados?: Record<string, unknown>): void {
    registrarProblemaHomologacao({
        tipo: "erro_validacao",
        mensagem,
        dados,
    });
}

// ======================= TIPOS (mínimos, práticos) =======================

export type TokenSource = "db" | "env";

export type EmpresaDefinida = {
    empresa: string;
    nomeEmpresa: string;

    userTiny: string;
    passTiny: string;

    tokenSource: TokenSource;
    idDeposito?: string | number | null;

    transfPositivo: boolean;
    transfNegativo: boolean;
    isMaster: boolean;

    empresaToken: string | null;
    tokenQuery: string | null;

    accessToken: string | null;
};

type MasterInfo = { empresa: string; isMaster: boolean };

type DepositoRow = {
    id: string | number;
    nome?: string | null;
    desconsiderar?: boolean | null;
};

type EstoqueProdTinyResponse = {
    depositos?: DepositoRow[];
};

// Agora, as variáveis já estão em process.env
export async function logEnvVariables(): Promise<boolean> {
    // ---- Verificação Manual ----
    // 1. Verifica se as variáveis essenciais estão definidas
    const variaveisObrigatorias = [
        "DB_HOST",
        "DB_PORT",
        "DB_USER",
        "DB_PASSWORD",
        "DB_DATABASE",
        "DB_SSL",
        "ACTIVE_COMPANIES",
    ] as const;

    const variaveisFaltando = variaveisObrigatorias.filter((v) => !process.env[v]);

    // Telefones / EvolutionAPI
    const activeTelsRaw = process.env.ACTIVE_TELS;
    const telEmEnv: string[] =
        activeTelsRaw === undefined ||
            activeTelsRaw === null ||
            activeTelsRaw === "" ||
            activeTelsRaw.toUpperCase() === "NONE"
            ? ["NONE"]
            : activeTelsRaw.split(",").map((a) => a.trim());

    if (telEmEnv[0].toUpperCase() !== "NONE") {
        const insEnv = process.env.INSTANCE_WAPI;
        const instance = !insEnv ? "" : insEnv.trim();

        const eBU = process.env.EVO_BASE_URL;
        const evoBaseUrl = !eBU ? "" : eBU;

        const eAK = process.env.EVO_API_KEY;
        const evoApiKey = !eAK ? "" : eAK;

        if (evoBaseUrl.length > 0) {
            console.log("🔗 Url base para o EvolutionAPI capturada do .env com sucesso! ✅");
        } else {
            const msg = "❌ Erro: Por favor, defina a URL base do Evolution API no .env com a variável EVO_BASE_URL.";
            console.error(msg);
            registrarErroValidacaoConfig(msg, { variavel: "EVO_BASE_URL" });
            finalizarRelatorioHomologacao("finalizado_com_erros");
            process.exit(1);
        }

        if (evoApiKey.length > 0) {
            console.log("🔑 Chave de API para o EvolutionAPI capturada do .env com sucesso! ✅");
        } else {
            const msg = "❌ Erro: Por favor, defina a chave de API do Evolution API no .env com a variável EVO_API_KEY.";
            console.error(msg);
            registrarErroValidacaoConfig(msg, { variavel: "EVO_API_KEY" });
            finalizarRelatorioHomologacao("finalizado_com_erros");
            process.exit(1);
        }

        if (instance.length > 0) {
            instanceWhatsApp.push(instance);
            console.log("🤝 Instância do Evolution API Capturada:", instanceWhatsApp[0], "✅");
        } else {
            const msg = "❌ Erro: Por favor, defina o nome da instância do Evolution API no .env com a variável INSTANCE_WAPI.";
            console.error(msg);
            registrarErroValidacaoConfig(msg, { variavel: "INSTANCE_WAPI" });
            finalizarRelatorioHomologacao("finalizado_com_erros");
            process.exit(1);
        }

        for (const tel of telEmEnv) {
            const telefone = process.env[`${tel}_TEL`];
            if (!telefone) {
                const msg = `❌ Erro: Foi realizado uma busca no .env de um número inválido. Por favor, adicione um ${tel}_TEL no .env.`;
                console.error(msg);
                registrarErroValidacaoConfig(msg, { variavel: `${tel}_TEL`, telefone: tel });
                await sendMessageMain(
                    msg
                );
                finalizarRelatorioHomologacao("finalizado_com_erros");
                process.exit(1);
            }
            listaTelefones.push(telefone);
        }
    } else {
        console.log("======================================================");
        console.log("🚨 Não foi definido um número de emergência no .env 🚨");
        console.log("⚠️   EM CASO DE ERRO, NINGUÉM SERÁ NOTIFICADO!!!   ⚠️");
        console.log("🔥🔥🔥 Continuando assim mesmo... 🔥🔥🔥");
        console.log("======================================================");
    }

    if (variaveisFaltando.length > 0) {
        const msg = `❌ Erro: As seguintes variáveis de ambiente estão faltando no .env: ${variaveisFaltando.join(", ")}`;
        console.error(msg);
        registrarErroValidacaoConfig(msg, { variaveis: variaveisFaltando });
        await sendMessageMain(
            msg
        );
        return false;
    }

    const activeCompanies = process.env.ACTIVE_COMPANIES;
    if (!activeCompanies) {
        const msg = "❌ Erro: ACTIVE_COMPANIES não definido no .env";
        console.error(msg);
        registrarErroValidacaoConfig(msg, { variavel: "ACTIVE_COMPANIES" });
        await sendMessageMain(msg);
        return false;
    }

    // Agora ele verifica as empresas declaradas e verifica se falta alguma informação
    const empresas = activeCompanies.split(",");

    /**
     * Deve haver exatamente 1 master.
     */
    const masters: MasterInfo[] = [];

    for (const empresa of empresas) {
        const nomeEmpresa = process.env[`${empresa}_NOME`]; // Obrigatório
        const tokenSource = process.env[`${empresa}_TOKEN_SOURCE`] as TokenSource | undefined; // Obrigatório
        const idDeposito = process.env[`${empresa}_ID_DEPOSITO`]; // Obrigatório (mas você tolera vazio para listar e sair)
        const userTiny = process.env[`${empresa}_USER_TINY`]; // Obrigatório (para não-master)
        const passTiny = process.env[`${empresa}_PASS_TINY`]; // Obrigatório (para não-master)
        const isMaster = process.env[`${empresa}_IS_MASTER`] === "true";

        let empresaToken: string | null = null;
        let tokenQuery: string | null = null;

        if (!nomeEmpresa) {
            const msg = `[❌ DADOS INCOMPLETOS] Por favor preencha o campo "${empresa}_NOME" para a empresa ${nomeEmpresa}/${empresa}.`;
            console.error(msg);
            registrarErroValidacaoConfig(msg, { empresa, variavel: `${empresa}_NOME` });
            await sendMessageMain(msg);
            finalizarRelatorioHomologacao("finalizado_com_erros");
            process.exit(1);
        }

        if (idDeposito === undefined || idDeposito === null || idDeposito === "") {
            const msg = `[❌ DADOS INCOMPLETOS] Por favor preencha o campo "${empresa}_ID_DEPOSITO" para a empresa ${nomeEmpresa}/${empresa}.`;
            console.error(msg);
            console.error(
                "[❌ DADOS INCOMPLETOS] O script não será encerrado, ele listará os IDs de depósito disponíveis e então ele irá encerrar."
            );
            registrarProblemaHomologacao({
                tipo: "deposito_nao_definido",
                empresa,
                nomeEmpresa,
                mensagem: msg,
                dados: { variavel: `${empresa}_ID_DEPOSITO` },
            }, { resumoValor: empresa });
            await sendMessageMain(
                msg
            );
            await sendMessageMain(
                "[❌ DADOS INCOMPLETOS] O script não será encerrado, ele listará os IDs de depósito disponíveis e então ele irá encerrar."
            );
            // (mantido seu comportamento: não dá exit aqui)
        }

        if (!isMaster) {
            if (!userTiny || !passTiny) {
                const msg = `[❌ DADOS INCOMPLETOS] Por favor preencha os campos "${empresa}_USER_TINY" e "${empresa}_PASS_TINY"`;
                console.error(msg);
                console.error(`[❌ DADOS INCOMPLETOS] Sem eles não será possível baixar a planilha de estoque.`);
                registrarErroValidacaoConfig(msg, {
                    empresa,
                    variaveis: [`${empresa}_USER_TINY`, `${empresa}_PASS_TINY`],
                });
                await sendMessageMain(msg);
                await sendMessageMain(`[❌ DADOS INCOMPLETOS] Sem eles não será possível baixar a planilha de estoque.`);
                finalizarRelatorioHomologacao("finalizado_com_erros");
                process.exit(1);
            }
        }

        if (tokenSource === "env") {
            empresaToken = process.env[`${empresa}_TOKEN`] ?? null;
            if (!empresaToken) {
                const msg = `[❌ DADOS INCOMPLETOS] Por favor preencha o campo "${empresa}_TOKEN" para a empresa ${nomeEmpresa}/${empresa}.`;
                console.error(msg);
                registrarErroValidacaoConfig(msg, { empresa, variavel: `${empresa}_TOKEN` });
                await sendMessageMain(msg);
                finalizarRelatorioHomologacao("finalizado_com_erros");
                process.exit(1);
            }
        } else if (tokenSource === "db") {
            tokenQuery = process.env[`${empresa}_TOKEN_QUERY`] ?? null;
            if (!tokenQuery) {
                const msg = `[❌ DADOS INCOMPLETOS] Por favor preencha o campo "${empresa}_TOKEN_QUERY" para a empresa ${nomeEmpresa}/${empresa}.`;
                console.error(msg);
                registrarErroValidacaoConfig(msg, { empresa, variavel: `${empresa}_TOKEN_QUERY` });
                await sendMessageMain(msg);
                finalizarRelatorioHomologacao("finalizado_com_erros");
                process.exit(1);
            }
        } else {
            const msg = `[❌ DADOS INCOMPLETOS] Por favor, preencha corretamente o campo "tokenSource" com 'env' ou 'db' para a empresa ${nomeEmpresa}/${empresa}.`;
            console.error(msg);
            registrarErroValidacaoConfig(msg, { empresa, variavel: `${empresa}_TOKEN_SOURCE`, valor: tokenSource });
            await sendMessageMain(msg);
            finalizarRelatorioHomologacao("finalizado_com_erros");
            process.exit(1);
        }

        masters.push({ empresa, isMaster });
    }

    if (masters.filter((v) => v.isMaster === true).length !== 1) {
        const msg = `[❌ DADOS INCOMPLETOS] Foi identificado que no .env há um erro com relação à empresa MASTER (principal).`;
        console.error(msg);
        console.error(
            "[❌ DADOS INCOMPLETOS] Lembrando que deve ter EXATAMENTE uma empresa master, deve haver somente uma!"
        );
        registrarErroValidacaoConfig(msg, { masters });
        await sendMessageMain(
            msg
        );
        await sendMessageMain(
            "[❌ DADOS INCOMPLETOS] Lembrando que deve ter EXATAMENTE uma empresa master, deve haver somente uma!"
        );
        console.log(masters);
        finalizarRelatorioHomologacao("finalizado_com_erros");
        process.exit(1);
    }

    console.log("✅ Todas as variáveis de ambiente obrigatórias estão definidas");

    // 3. Testa a conexão com o banco de dados
    const isConectado = await conectarAoBanco();
    return Boolean(isConectado);
}

/**
 * @description Busca toda a informação do .env e retorna uma lista de empresas já com as infos.
 */
export async function definirEmpresas(): Promise<EmpresaDefinida[]> {
    const activeCompanies = process.env.ACTIVE_COMPANIES;
    if (!activeCompanies) {
        console.error("🚨 ERRO INESPERADO!!! 🚨");
        console.error("ACTIVE_COMPANIES está vazio/undefined no .env");
        await sendMessageMain("🚨 ERRO INESPERADO!!! 🚨");
        await sendMessageMain("ACTIVE_COMPANIES está vazio/undefined no .env");
        process.exit(1);
    }

    const empresas = activeCompanies.split(","); // ["JP", "LT", "JF"]
    const listaCompleta: EmpresaDefinida[] = [];

    for (const empresa of empresas) {
        const nomeEmpresa = process.env[`${empresa}_NOME`]; // Obrigatório
        const userTiny = process.env[`${empresa}_USER_TINY`] ?? "";
        const passTiny = process.env[`${empresa}_PASS_TINY`] ?? "";
        const tokenSource = process.env[`${empresa}_TOKEN_SOURCE`] as TokenSource | undefined;
        const idDeposito = process.env[`${empresa}_ID_DEPOSITO`] ?? null;
        const isMaster = process.env[`${empresa}_IS_MASTER`] === "true";
        const transfPositivo = process.env[`${empresa}_SALDO_POSITIVO`] === "false" ? false : true;
        const transfNegativo = process.env[`${empresa}_SALDO_NEGATIVO`] === "false" ? false : true;

        let empresaToken: string | null = null;
        let tokenQuery: string | null = null;

        if (!nomeEmpresa) {
            const msg = `Por favor preencha o campo "${empresa}_NOME" para a empresa ${nomeEmpresa}/${empresa}.`;
            console.error(msg);
            registrarErroValidacaoConfig(msg, { empresa, variavel: `${empresa}_NOME` });
            await sendMessageMain(msg);
            finalizarRelatorioHomologacao("finalizado_com_erros");
            process.exit(1);
        }

        if (tokenSource === "env") {
            empresaToken = process.env[`${empresa}_TOKEN`] ?? null;
            if (!empresaToken) {
                const msg = `Por favor preencha o campo "${empresa}_TOKEN" para a empresa ${nomeEmpresa}/${empresa}.`;
                console.error(msg);
                registrarErroValidacaoConfig(msg, { empresa, variavel: `${empresa}_TOKEN` });
                await sendMessageMain(msg);
                finalizarRelatorioHomologacao("finalizado_com_erros");
                process.exit(1);
            }

            listaCompleta.push({
                empresa,
                nomeEmpresa,
                userTiny,
                passTiny,
                tokenSource,
                idDeposito,
                transfPositivo,
                transfNegativo,
                isMaster,
                empresaToken,
                tokenQuery: null,
                accessToken: null,
            });
        } else if (tokenSource === "db") {
            tokenQuery = process.env[`${empresa}_TOKEN_QUERY`] ?? null;
            if (!tokenQuery) {
                const msg = `Por favor preencha o campo "${empresa}_TOKEN_QUERY" para a empresa ${nomeEmpresa}/${empresa}.`;
                console.error(msg);
                registrarErroValidacaoConfig(msg, { empresa, variavel: `${empresa}_TOKEN_QUERY` });
                await sendMessageMain(msg);
                finalizarRelatorioHomologacao("finalizado_com_erros");
                process.exit(1);
            }

            listaCompleta.push({
                empresa,
                nomeEmpresa,
                userTiny,
                passTiny,
                tokenSource,
                idDeposito,
                transfPositivo,
                transfNegativo,
                isMaster,
                empresaToken: null,
                tokenQuery,
                accessToken: null,
            });
        } else {
            console.error("======######======");
            console.error("ERRO INESPERADO!!!");
            console.error("======######======");
            const msg = `Por favor, preencha corretamente o campo "tokenSource" com 'env' ou 'db' para a empresa ${nomeEmpresa}/${empresa}.`;
            console.error(msg);
            registrarErroValidacaoConfig(msg, { empresa, variavel: `${empresa}_TOKEN_SOURCE`, valor: tokenSource });
            await sendMessageMain("🚨 ERRO INESPERADO!!! 🚨");
            await sendMessageMain(msg);
            finalizarRelatorioHomologacao("finalizado_com_erros");
            process.exit(1);
        }
    }

    if (listaCompleta.length !== 0) return listaCompleta;

    console.error("======######======");
    console.error("ERRO INESPERADO!!!");
    console.error("listaCompleta.length === 0");
    console.error("======######======");
    registrarProblemaHomologacao({
        tipo: "erro_inesperado",
        contexto: "definirEmpresas",
        mensagem: "listaCompleta.length === 0",
    });
    await sendMessageMain("🚨 ERRO INESPERADO!!! 🚨");
    await sendMessageMain("listaCompleta.length === 0");
    await sendMessageMain("Isso significa que não foi definida nenhuma empresa no .env (Meio impossível... mas dá uma olhada)");
    finalizarRelatorioHomologacao("finalizado_com_erros");
    process.exit(1);
}

/**
 * @description Chamado quando faltar ID_DEPOSITO em alguma empresa.
 * Lista todos os depósitos com IDs para você preencher no .env.
 */
export async function semDepositosEnv(): Promise<never> {
    console.log("Foi identificado que não há ID_DEPOSITO dentro do .env");
    console.log("LISTANDO DEPOSITOS...\n");

    if (!listaEmpresasDefinidas || listaEmpresasDefinidas.length === 0) {
        const msg = "❌ listaEmpresasDefinidas está vazia/null. Chame definirEmpresas() antes.";
        console.error(msg);
        registrarProblemaHomologacao({
            tipo: "erro_inesperado",
            contexto: "semDepositosEnv",
            mensagem: msg,
        });
        await sendMessageMain(msg);
        finalizarRelatorioHomologacao("finalizado_com_erros");
        process.exit(1);
    }

    const listaDepositos: Record<string, DepositoRow[]> = {};

    for (const empresaDefinida of listaEmpresasDefinidas as unknown as EmpresaDefinida[]) {
        const depositos = (await getEstoqueProdTiny(empresaDefinida.empresa)) as EstoqueProdTinyResponse;

        const rows = depositos.depositos ?? [];
        listaDepositos[empresaDefinida.nomeEmpresa] = rows;
    }

    for (const empresa of Object.keys(listaDepositos)) {
        console.log("=".repeat(70));
        console.log(`${empresa}`);
        console.log("=".repeat(70));

        const rows = (listaDepositos[empresa] ?? []).map((d) => ({
            ID: d.id,
            Nome: d.nome ?? "",
            EstoqueConsiderado: d.desconsiderar ?? "false",
        }));

        console.table(rows);
        console.log("\n");
    }

    finalizarRelatorioHomologacao("finalizado_com_erros");
    process.exit(0);
}
