// ### ./src/main.ts ###

// Importa as variáveis do .env
import dotenv from "dotenv";
dotenv.config();

// ## index.js ##
import {
    logEnvVariables,
    semDepositosEnv,
    definirEmpresas,
    historyDbConfig,
} from "./config/index.js";

// #### services ####
// ## tinyApi.service.js ##
import { editEstoqueProdTiny, getProdTiny, type TinyPostRequestObserver } from "./services/tinyApi.service.js";

// ## sheet.service.js ##
import { filtrarPlanilha } from "./services/sheet.service.js";
import {
    filtrarPorDebugSku,
    formatarDebugSkus,
    obterDebugSkus,
} from "./services/debugSku.service.js";

// ## session.service.js ##
import { getAccessToken } from "./services/session.service.js";

// ## database.service.ts ##
import { conectarAoBanco } from "./services/database.service.js";

// ## transferenciasDb.service.ts ##
import { registrarTransferenciaParNoDb } from "./services/transferenciasDb.service.js";
import { construirDiagnosticoTransferencia } from "./services/transferDiagnostic.service.js";

// ## tinyPuppeteer.service.js ##
import {
    baixarPlanilhaDeposito,
    limparArquivosPorExtensao,
} from "./services/tinyPuppeteer.service.js";

// ## sendMessage.service.js ##
import { sendMessage } from "./services/sendMessage.service.js";

// ## homologacaoReport.service.js ##
import {
    finalizarRelatorioHomologacao,
    getRelatorioHomologacaoPath,
    iniciarRelatorioHomologacao,
    prepararCategoriasEmpresasHomologacao,
    registrarProblemaHomologacao,
    registrarProdutoNaoExiste,
} from "./services/homologacaoReport.service.js";

// Imports adicionais
import { randomUUID } from "crypto";

// ======================= TIPOS LOCAIS (mínimos) =======================

// Você pode refinar depois que migrar os services/config para TS.
type Empresa = {
    empresa: string;
    nomeEmpresa: string;
    isMaster?: boolean;

    userTiny: string;
    passTiny: string;
    tokenSource?: "db" | "env";
    idDeposito: string | number;

    transfPositivo: boolean;
    transfNegativo: boolean;
};

type PlanilhaRow = {
    codigo_sku?: string | number | null;
    estoque_atual: number;
};

type SkuDuplicadoPlanilha = {
    sku: string;
    linhas: PlanilhaRow[];
};

type TinyProduto = {
    id: string | number;
    descricao: string;
};

type TinyGetProdResponse =
    | {
        itens?: TinyProduto[];
    }
    | null
    | undefined;

// Erro custom da sua API (inferido pelo uso no código)
type TinyApiError = Error & {
    name: "TinyApiError";
    status?: number;
    url?: string;
    responseData?: unknown;
    requestData?: unknown;
    method?: string;
};

// Payload do sendMessage (inferido pelo uso)
type SendMessagePayload = {
    number: string;
    text: string;
    instance: string;
    linkPreview: boolean;
    idempotencyKey: string;
};

// ======================= VARIÁVEIS GLOBAIS =======================

export let listaEmpresasDefinidas: Empresa[] | null = null;
export let instanceWhatsApp: string[] = [];
export let listaTelefones: string[] = [];

/**
 * Resolve o ID da empresa para histórico (somente quando REGISTRAR_HISTORICO_DB=true).
 * - Corrige o erro TS: "resolveCompanyId não existe no tipo { enabled:false }"
 * - Centraliza a regra: ninguém chama resolveCompanyId sem checar enabled.
 */
async function resolveCompanyIdForHistory(empresaCodigo: string): Promise<number> {
    if (!historyDbConfig.enabled) {
        throw new Error(
            `Tentativa de resolver ID de empresa para histórico com REGISTRAR_HISTORICO_DB=false (empresa=${empresaCodigo}).`
        );
    }
    return historyDbConfig.resolveCompanyId(String(empresaCodigo).toUpperCase());
}

function localizarSkusDuplicados(linhas: PlanilhaRow[]): SkuDuplicadoPlanilha[] {
    const porSku = new Map<string, PlanilhaRow[]>();

    for (const linha of linhas) {
        if (linha.codigo_sku === undefined || linha.codigo_sku === null) continue;

        const sku = String(linha.codigo_sku).trim();
        if (!sku) continue;

        const ocorrencias = porSku.get(sku) ?? [];
        ocorrencias.push(linha);
        porSku.set(sku, ocorrencias);
    }

    return [...porSku.entries()]
        .filter(([, linhasDoSku]) => linhasDoSku.length > 1)
        .map(([sku, linhasDoSku]) => ({ sku, linhas: linhasDoSku }));
}

/**
 * Barreira de segurança: uma planilha com o mesmo SKU em mais de uma linha
 * não é confiável para movimentação. Registramos todos os casos e bloqueamos
 * o job antes do primeiro POST de estoque.
 */
async function bloquearTransferenciasPorSkusDuplicados(
    planilhasPorEmpresa: Map<Empresa, PlanilhaRow[]>
): Promise<void> {
    let encontrouDuplicidade = false;

    for (const [empresa, linhas] of planilhasPorEmpresa) {
        const duplicados = localizarSkusDuplicados(linhas);

        for (const duplicado of duplicados) {
            encontrouDuplicidade = true;

            let produtoTiny: TinyProduto | null = null;
            try {
                const resposta = (await getProdTiny(
                    "codigo",
                    duplicado.sku,
                    empresa.empresa
                )) as TinyGetProdResponse;
                produtoTiny = resposta?.itens?.[0] ?? null;
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(
                    `[AVISO] Não foi possível complementar o SKU duplicado ${duplicado.sku} com dados da Tiny: ${message}`
                );
            }

            const quantidades = duplicado.linhas.map((linha) => linha.estoque_atual);
            const detalhes = {
                sku: duplicado.sku,
                empresa: empresa.empresa,
                nome_empresa: empresa.nomeEmpresa,
                produto_nome: produtoTiny?.descricao ?? "não localizado",
                produto_id_tiny: produtoTiny?.id ?? "não localizado",
                ocorrencias: duplicado.linhas.length,
                quantidades_estoque: quantidades,
                soma_quantidades: quantidades.reduce((total, quantidade) => total + Number(quantidade), 0),
            };

            console.error("❌ SKU DUPLICADO DETECTADO NA PLANILHA — NENHUMA TRANSFERÊNCIA SERÁ EXECUTADA PARA ESTE JOB.");
            console.table([detalhes]);

            registrarProblemaHomologacao({
                tipo: "sku_duplicado_planilha",
                sku: duplicado.sku,
                empresa: empresa.empresa,
                nomeEmpresa: empresa.nomeEmpresa,
                mensagem: `SKU ${duplicado.sku} aparece ${duplicado.linhas.length} vezes na planilha. Execução bloqueada por segurança.`,
                dados: detalhes,
            }, { resumoValor: `${empresa.empresa}:${duplicado.sku}` });
        }
    }

    if (!encontrouDuplicidade) return;

    const msg = "❌ Execução bloqueada: foram encontrados SKUs duplicados nas planilhas. Corrija as duplicidades e execute novamente. Nenhuma movimentação de estoque foi enviada.";
    console.error(msg);
    await sendMessageMain(msg);
    finalizarRelatorioHomologacao("finalizado_com_erros");
    process.exit(1);
}

async function main(): Promise<void> {
    iniciarRelatorioHomologacao();
    await allValidations();

    // || ================ BAIXA A PLANILHA DE ESTOQUE ================ || \\
    const extensions = [".csv", ".xls", ".xlsx", ".ods", ".fods", ".tsv"];
    limparArquivosPorExtensao("./data", extensions);

    // Cria o objeto com o caminho das planilhas de acordo com a empresa definida no .env
    const objPathPlanilhas: Record<string, string> = {};

    if (!listaEmpresasDefinidas) {
        // proteção extra (teoricamente allValidations garante)
        throw new Error("listaEmpresasDefinidas não foi inicializada.");
    }
    const empresasDefinidas = listaEmpresasDefinidas;
    const debugSkus = obterDebugSkus();
    if (debugSkus) {
        console.warn(`🐞 DEBUG_SKU ativo: somente os SKUs [${formatarDebugSkus(debugSkus)}] poderão gerar movimentações.`);
    }

    // Baixa cada uma das planilhas de estoque (exceto da empresa principal)
    const planilhasCompletasPorEmpresa = new Map<Empresa, PlanilhaRow[]>();
    const planilhasFiltradasPorEmpresa = new Map<Empresa, PlanilhaRow[]>();

    // Pré-validação completa: não movimenta nenhuma empresa antes de garantir
    // que todas as planilhas elegíveis não contêm SKU duplicado.
    for (const empresa of empresasDefinidas) {
        if (empresa.isMaster) continue; // Pula a empresa principal
        const e = empresa;

        const idDeposito = e.idDeposito;
        if (idDeposito === undefined || idDeposito === null || idDeposito === "") {
            const msg = `❌ Empresa ${e.empresa} está sem idDeposito definido. Verifique o .env (_ID_DEPOSITO).`;
            console.error(msg);
            registrarProblemaHomologacao({
                tipo: "deposito_nao_definido",
                empresa: e.empresa,
                nomeEmpresa: e.nomeEmpresa,
                mensagem: msg,
            }, { resumoValor: e.empresa });
            await sendMessageMain(msg);
            finalizarRelatorioHomologacao("finalizado_com_erros");
            process.exit(1);
        }

        const caminhoPlanilha: string = await baixarPlanilhaDeposito(
            e.userTiny,
            e.passTiny,
            idDeposito,
            `./data/inventario-${e.empresa.toLowerCase()}.xls`,
            e.empresa
        );

        console.log(caminhoPlanilha);
        objPathPlanilhas[e.empresa] = caminhoPlanilha;
    }

    console.log("=== PLANILHAS ===");
    console.log(objPathPlanilhas);
    console.log("==== [ END ] ====");

    for (const empresa of empresasDefinidas) {
        if (empresa.isMaster) continue; // Pula a empresa principal

        const caminhoPlanilha = `./data/inventario-${empresa.empresa.toLowerCase()}.xls`;
        const linhasCompletas = filtrarPlanilha(caminhoPlanilha, "F", "") as PlanilhaRow[];
        planilhasCompletasPorEmpresa.set(empresa, linhasCompletas);

        if (debugSkus) {
            const saldosDebug = filtrarPorDebugSku(linhasCompletas, debugSkus);
            for (const linha of saldosDebug) {
                console.log(
                    `🐞 DEBUG_SKU | SKU=${String(linha.codigo_sku)} | empresa=${empresa.empresa} | saldo=${linha.estoque_atual}`
                );
            }
            const encontrados = new Set(saldosDebug.map((linha) => String(linha.codigo_sku).trim().toUpperCase()));
            for (const sku of debugSkus) {
                if (!encontrados.has(sku)) {
                    console.log(`🐞 DEBUG_SKU | SKU=${sku} | empresa=${empresa.empresa} | saldo=não localizado na planilha`);
                }
            }
        }

        const filterMap: Record<string, string | null> = {
            true_true: "!=0", // pode positivos e negativos → diferente de zero
            false_true: "<0", // só negativos
            true_false: ">0", // só positivos
            false_false: null, // nenhum → não faz nada
        };

        const filterKey = `${empresa.transfPositivo}_${empresa.transfNegativo}`;
        const filtro = filterMap[filterKey];

        if (filtro === null) {
            console.log(
                `\n--- Nenhuma transferência configurada para a empresa ${empresa.nomeEmpresa}. Pulando. ---`
            );
            continue;
        }

        const linhasComSaldo = filtrarPlanilha(
            caminhoPlanilha,
            "F",
            filtro
        ) as PlanilhaRow[];
        const a = filtrarPorDebugSku(linhasComSaldo, debugSkus);

        const messageEstoque =
            filtro === "<0" ? "menor que 0" : filtro === ">0" ? "maior que 0" : "diferente de 0";

        console.log(
            `Foram localizados ${a.length} produtos com o estoque ${messageEstoque} na empresa ${empresa.nomeEmpresa}${debugSkus ? " (filtrado por DEBUG_SKU)" : ""}`
        );

        planilhasFiltradasPorEmpresa.set(empresa, a);
    }

    await bloquearTransferenciasPorSkusDuplicados(planilhasCompletasPorEmpresa);

    const objEmpresaMaster = empresasDefinidas.find((v) => v.isMaster === true);
    if (!objEmpresaMaster) {
        registrarProblemaHomologacao({
            tipo: "erro_validacao",
            mensagem: "Empresa Master não encontrada em listaEmpresasDefinidas.",
        });
        finalizarRelatorioHomologacao("finalizado_com_erros");
        throw new Error("Empresa Master não encontrada em listaEmpresasDefinidas.");
    }

    for (const [empresa, a] of planilhasFiltradasPorEmpresa) {
        for (const p of a) {
            if (!p.codigo_sku) {
                registrarProblemaHomologacao({
                    tipo: "sku_vazio_planilha",
                    empresa: empresa.empresa,
                    nomeEmpresa: empresa.nomeEmpresa,
                    mensagem: `Linha da planilha sem SKU na empresa ${empresa.nomeEmpresa}.`,
                    dados: { estoque_atual: p.estoque_atual },
                });
                continue;
            }
            if (debugSkus) {
                const direcao = p.estoque_atual > 0
                    ? `${empresa.empresa} → ${objEmpresaMaster.empresa}`
                    : p.estoque_atual < 0
                        ? `${objEmpresaMaster.empresa} → ${empresa.empresa}`
                        : "sem movimentação";
                console.log(
                    `🐞 DEBUG_SKU | transferência prevista | SKU=${String(p.codigo_sku)} | saldo=${p.estoque_atual} | direção=${direcao}`
                );
            }
            const ok = await transfEstoque(p, empresa, objEmpresaMaster);
            if (!ok) continue;
        }
    }

    await sendMessageMain(`✨ Processo concluído!
🎉 Todas as operações foram executadas com sucesso.
📊 Estoques atualizados e sincronizados.
🔒 Sistema encerrado com segurança.
Até a próxima execução! 👋`);

    console.log("\n✨ Processo concluído!");
    console.log("🎉 Todas as operações foram executadas com sucesso.");
    console.log("📊 Estoques atualizados e sincronizados.");
    console.log("🔒 Sistema encerrado com segurança.");
    console.log("Até a próxima execução! 👋\n");
    console.log(`🧾 Relatório de homologação salvo em: ${getRelatorioHomologacaoPath()}`);

    finalizarRelatorioHomologacao("concluido");
    process.exit(0);
}

async function allValidations(): Promise<void> {
    // Verifica se todas as variáveis foram preenchidas corretamente no .env
    const allVariables = await logEnvVariables();

    if (!allVariables) {
        const msg = "❌ Erro: Falha na validação das variáveis de ambiente. Verifique o .env e tente novamente.";
        console.error(
            msg
        );
        registrarProblemaHomologacao({
            tipo: "erro_validacao",
            mensagem: msg,
        });
        await sendMessageMain(
            msg
        );
        finalizarRelatorioHomologacao("finalizado_com_erros");
        process.exit(1);
    }

    console.log("✅ Variáveis de ambiente validadas com sucesso. Iniciando o sistema...");

    // Testa conexão com o banco antes de qualquer coisa
    const okDb = await conectarAoBanco();
    if (!okDb) {
        const msg = "❌ Banco de dados indisponível. Abortando execução por segurança.";
        console.error(msg);
        registrarProblemaHomologacao({
            tipo: "erro_banco",
            mensagem: msg,
        });
        await sendMessageMain(msg);
        finalizarRelatorioHomologacao("finalizado_com_erros");
        process.exit(1);
    }

    // Define as empresas dentro da lista global com todas as variáveis do .env padronizadas corretamente
    listaEmpresasDefinidas = (await definirEmpresas()) as Empresa[];
    prepararCategoriasEmpresasHomologacao(listaEmpresasDefinidas);

    // Captura o AccessToken do Tiny de cada uma das empresas com base no Query
    for (const empresa of listaEmpresasDefinidas) {
        await getAccessToken(empresa.empresa);
    }

    // Verifica se existe algum '_ID_DEPOSITO' dentro do .env que não está preenchido.
    const idDepositoVazio = listaEmpresasDefinidas.some(
        (v) => v.idDeposito === undefined || v.idDeposito === null || v.idDeposito === ""
    );

    if (idDepositoVazio) {
        await semDepositosEnv();

        // Recarrega as empresas depois que o usuário preencher os depósitos
        listaEmpresasDefinidas = (await definirEmpresas()) as Empresa[];

        // Se ainda tiver depósito vazio, aborta (não deixa seguir com undefined/null)
        const aindaVazio = listaEmpresasDefinidas.some(
            (v) => v.idDeposito === undefined || v.idDeposito === null || v.idDeposito === ""
        );

        if (aindaVazio) {
            const msg = "❌ ID_DEPOSITO ainda está vazio após a validação. Abordando execução por segurança.";
            console.error(msg);
            for (const empresa of listaEmpresasDefinidas.filter(
                (v) => v.idDeposito === undefined || v.idDeposito === null || v.idDeposito === ""
            )) {
                registrarProblemaHomologacao({
                    tipo: "deposito_nao_definido",
                    empresa: empresa.empresa,
                    nomeEmpresa: empresa.nomeEmpresa,
                    mensagem: `ID_DEPOSITO vazio para ${empresa.nomeEmpresa} (${empresa.empresa}).`,
                }, { resumoValor: empresa.empresa });
            }
            await sendMessageMain(msg);
            finalizarRelatorioHomologacao("finalizado_com_erros");
            process.exit(1);
        }
    }
}

function extrairIdLancamento(resp: unknown): number {
    if (!resp || typeof resp !== "object") {
        throw new Error("Resposta do Tiny inválida (sem objeto).");
    }

    const o = resp as Record<string, unknown>;

    // Formatos comuns
    const candidatos = [
        o.idLancamento,
        o.id_lancamento,
        o.idLancamentoEstoque,
        (o.retorno as any)?.idLancamento,
        (o.retorno as any)?.id_lancamento,
    ];

    for (const c of candidatos) {
        const n = typeof c === "string" ? Number(c) : typeof c === "number" ? c : NaN;
        if (Number.isFinite(n) && n > 0) return n;
    }

    throw new Error(`Não foi possível extrair idLancamento da resposta: ${JSON.stringify(resp)}`);
}

function normalizarEstoqueParaTransferencia(valor: number): number {
    if (!Number.isFinite(valor)) return 0;

    // Se já é inteiro, mantém
    if (Number.isInteger(valor)) return valor;

    // Positivo quebrado: 9.99 -> 9 | 0.1 -> 0
    if (valor > 0) return Math.floor(valor);

    // Negativo quebrado: -13.7 -> -13 | -0.1 -> 0
    // (arredonda em direção ao zero)
    if (valor < 0) return Math.ceil(valor);

    return 0;
}

async function transfEstoque(
    p: PlanilhaRow,
    empresaFilial: Empresa,
    objEmpresaMaster: Empresa
): Promise<boolean> {
    const sku = p.codigo_sku;
    const skuTexto = String(sku ?? "");
    const urlBuscaProduto = `https://api.tiny.com.br/public-api/v3/produtos?codigo=${encodeURIComponent(skuTexto)}&situacao=A`;
    const rastreioTransferencia = {
        sku: skuTexto,
        saldoPlanilha: Number(p.estoque_atual),
        consultasProduto: {
            master: { empresa: objEmpresaMaster.empresa, url: urlBuscaProduto, produtoSelecionado: null as { id: string | number; descricao?: string } | null, resultado: { sucesso: false, status: null as number | string | null, responseData: null as unknown } },
            filial: { empresa: empresaFilial.empresa, url: urlBuscaProduto, produtoSelecionado: null as { id: string | number; descricao?: string } | null, resultado: { sucesso: false, status: null as number | string | null, responseData: null as unknown } },
        },
        depositos: {} as Record<string, { empresa: string; valor: string | number; origem: string }>,
        autenticacao: {
            master: { empresa: objEmpresaMaster.empresa, origem: `${objEmpresaMaster.empresa}_TOKEN_SOURCE`, fonte: objEmpresaMaster.tokenSource ?? "desconhecida" as "db" | "env" | "desconhecida" },
            filial: { empresa: empresaFilial.empresa, origem: `${empresaFilial.empresa}_TOKEN_SOURCE`, fonte: empresaFilial.tokenSource ?? "desconhecida" as "db" | "env" | "desconhecida" },
        },
        movimentacoes: [] as Array<{ etapa: string; empresa: string; tentativa?: number; url: string; body: Record<string, unknown>; resultado: { status?: number | string | null; responseData?: unknown; sucesso?: boolean } }>,
    };
    let consultaEmAndamento: "master" | "filial" | null = null;
    let postagemEmAndamento: { etapa: string; empresa: string } | null = null;
    const indicesTentativasPost = new Map<number, number>();
    const observarPostEfetivo = (evento: Parameters<TinyPostRequestObserver>[0]): void => {
        if (!postagemEmAndamento) return;
        if (evento.tipo === "requisicao") {
            const indice = rastreioTransferencia.movimentacoes.push({
                ...postagemEmAndamento, tentativa: evento.tentativa, url: evento.url, body: evento.body,
                resultado: { sucesso: false, status: null },
            }) - 1;
            indicesTentativasPost.set(evento.tentativa, indice);
            return;
        }
        const indice = indicesTentativasPost.get(evento.tentativa);
        if (indice === undefined) return;
        rastreioTransferencia.movimentacoes[indice].resultado = {
            sucesso: evento.sucesso, status: evento.status, responseData: evento.responseData,
        };
    };

    if (sku === undefined || sku === null || sku === "") {
        console.warn("[WARN] Linha da planilha sem SKU (codigo_sku vazio). Pulando.");
        registrarProblemaHomologacao({
            tipo: "sku_vazio_planilha",
            empresa: empresaFilial.empresa,
            nomeEmpresa: empresaFilial.nomeEmpresa,
            mensagem: "Linha da planilha sem SKU (codigo_sku vazio).",
            dados: { estoque_atual: p.estoque_atual },
        });
        return true;
    }

    console.log(`\n--- Processando SKU: ${String(sku)} | Estoque encontrado: ${p.estoque_atual} ---`);

    // 1. Normaliza para não enviar decimal para a API (produto por KG, etc.)
    const estoqueNormalizado = normalizarEstoqueParaTransferencia(Number(p.estoque_atual));

    if (!Number.isInteger(p.estoque_atual)) {
        await logInfo(
            `[INFO] Estoque decimal detectado (original=${p.estoque_atual}) -> normalizado=${estoqueNormalizado}`,
            true
        );
    }

    if (estoqueNormalizado === 0) {
        await logInfo(
            `[INFO] Estoque não transferível (valor original=${p.estoque_atual}). Nenhuma transferência necessária. Pulando.`,
            true
        );
        registrarProblemaHomologacao({
            tipo: "estoque_nao_transferivel",
            sku: String(sku),
            empresa: empresaFilial.empresa,
            nomeEmpresa: empresaFilial.nomeEmpresa,
            mensagem: `Estoque não transferível para o SKU ${String(sku)}.`,
            dados: {
                estoque_original: p.estoque_atual,
                estoque_normalizado: estoqueNormalizado,
            },
        });
        return true;
    }

    try {
        // ==================================================================
        // ETAPA 1: BUSCAR E VALIDAR PRODUTOS (LÓGICA CENTRALIZADA)
        // ==================================================================
        consultaEmAndamento = "master";
        const resProdMaster = (await getProdTiny(
            "codigo",
            sku,
            objEmpresaMaster.empresa
        )) as TinyGetProdResponse;
        rastreioTransferencia.consultasProduto.master.resultado = { sucesso: true, status: 200, responseData: resProdMaster };

        const prodMaster = resProdMaster?.itens?.[0];
        if (!prodMaster) {
            const msg = `[❌ FALHA] Produto não encontrado na empresa principal [${objEmpresaMaster.nomeEmpresa}].`;
            console.error(msg);
            registrarProdutoNaoExiste({
                sku,
                escopo: "master",
                empresa: objEmpresaMaster.empresa,
                nomeEmpresa: objEmpresaMaster.nomeEmpresa,
                mensagem: msg,
            });
            return false;
        }
        rastreioTransferencia.consultasProduto.master.produtoSelecionado = { id: prodMaster.id, descricao: prodMaster.descricao };
        console.log(`[OK] Localizado na Master: ${prodMaster.descricao} (ID: ${prodMaster.id})`);

        consultaEmAndamento = "filial";
        const resProdFilial = (await getProdTiny(
            "codigo",
            sku,
            empresaFilial.empresa
        )) as TinyGetProdResponse;
        rastreioTransferencia.consultasProduto.filial.resultado = { sucesso: true, status: 200, responseData: resProdFilial };

        const prodFilial = resProdFilial?.itens?.[0];
        if (!prodFilial) {
            const msg = `[❌ FALHA] Produto não encontrado na empresa filial [${empresaFilial.nomeEmpresa}].`;
            console.error(msg);
            registrarProdutoNaoExiste({
                sku,
                escopo: "filial",
                empresa: empresaFilial.empresa,
                nomeEmpresa: empresaFilial.nomeEmpresa,
                mensagem: msg,
            });
            return false;
        }
        rastreioTransferencia.consultasProduto.filial.produtoSelecionado = { id: prodFilial.id, descricao: prodFilial.descricao };
        console.log(`[OK] Localizado na Filial: ${prodFilial.descricao} (ID: ${prodFilial.id})`);

        // ==================================================================
        // ETAPA 2: EXECUTAR A TRANSFERÊNCIA (LÓGICA CONDICIONAL)
        // ==================================================================
        const idDepFilial = empresaFilial.idDeposito;
        const idDepMaster = objEmpresaMaster.idDeposito;

        rastreioTransferencia.depositos = {
            master: { empresa: objEmpresaMaster.empresa, valor: idDepMaster, origem: `${objEmpresaMaster.empresa}_ID_DEPOSITO` },
            filial: { empresa: empresaFilial.empresa, valor: idDepFilial, origem: `${empresaFilial.empresa}_ID_DEPOSITO` },
        };

        if (idDepFilial === undefined || idDepFilial === null || idDepFilial === "") {
            const msg = `❌ Filial ${empresaFilial.empresa} sem idDeposito. Abortando SKU ${String(p.codigo_sku)}.`;
            console.error(msg);
            registrarProblemaHomologacao({
                tipo: "deposito_nao_definido",
                sku: String(sku),
                empresa: empresaFilial.empresa,
                nomeEmpresa: empresaFilial.nomeEmpresa,
                mensagem: msg,
            }, { resumoValor: `${empresaFilial.empresa}:${String(sku)}` });
            await sendMessageMain(msg);
            return false;
        }

        if (idDepMaster === undefined || idDepMaster === null || idDepMaster === "") {
            const msg = `❌ Master ${objEmpresaMaster.empresa} sem idDeposito. Abortando SKU ${String(p.codigo_sku)}.`;
            console.error(msg);
            registrarProblemaHomologacao({
                tipo: "deposito_nao_definido",
                sku: String(sku),
                empresa: objEmpresaMaster.empresa,
                nomeEmpresa: objEmpresaMaster.nomeEmpresa,
                mensagem: msg,
            }, { resumoValor: `${objEmpresaMaster.empresa}:${String(sku)}` });
            await sendMessageMain(msg);
            return false;
        }

        const qtdAbs = Math.abs(estoqueNormalizado);

        if (estoqueNormalizado > 0) {
            // ✅ LT -> JP (filial tinha saldo positivo e vai "devolver" para master)
            console.log(
                `Iniciando transferência: ${qtdAbs} unidades da ${empresaFilial.empresa} para ${objEmpresaMaster.empresa}.`
            );

            // Saída da Filial
            postagemEmAndamento = { etapa: "saida_filial", empresa: empresaFilial.empresa };
            const respSaida = await editEstoqueProdTiny(
                empresaFilial.empresa,
                prodFilial.id,
                "S",
                qtdAbs,
                idDepFilial,
                objEmpresaMaster.empresa, 0, observarPostEfetivo
            );

            // Entrada na Master
            postagemEmAndamento = { etapa: "entrada_master", empresa: objEmpresaMaster.empresa };
            const respEntrada = await editEstoqueProdTiny(
                objEmpresaMaster.empresa,
                prodMaster.id,
                "E",
                qtdAbs,
                idDepMaster,
                empresaFilial.empresa, 0, observarPostEfetivo
            );

            // ✅ Só grava depois que as duas deram OK
            const idLancSaida = extrairIdLancamento(respSaida);
            const idLancEntrada = extrairIdLancamento(respEntrada);

            // ✅ HISTÓRICO opcional (evita qualquer acesso/uso quando desligado)
            if (historyDbConfig.enabled) {
                const idEmpresaMasterDb = await resolveCompanyIdForHistory(objEmpresaMaster.empresa);
                const idEmpresaFilialDb = await resolveCompanyIdForHistory(empresaFilial.empresa);

                await registrarTransferenciaParNoDb(
                    {
                        idProdutoTiny: prodFilial.id,
                        skuProduto: String(sku),
                        nomeProduto: prodFilial.descricao,
                        quantidade: qtdAbs,

                        empresaEntradaId: idEmpresaMasterDb,
                        empresaSaidaId: idEmpresaFilialDb,

                        idLancamento: idLancSaida,
                        tipoLancamento: "S",
                    },
                    {
                        idProdutoTiny: prodMaster.id,
                        skuProduto: String(sku),
                        nomeProduto: prodMaster.descricao,
                        quantidade: qtdAbs,

                        empresaEntradaId: idEmpresaMasterDb,
                        empresaSaidaId: idEmpresaFilialDb,

                        idLancamento: idLancEntrada,
                        tipoLancamento: "E",
                    }
                );
            }
        } else {
            // ✅ JP -> LT (filial está negativo, master cobre)
            console.log(
                `Iniciando transferência: ${qtdAbs} unidades da ${objEmpresaMaster.empresa} para ${empresaFilial.empresa}.`
            );

            // Saída da Master
            postagemEmAndamento = { etapa: "saida_master", empresa: objEmpresaMaster.empresa };
            const respSaida = await editEstoqueProdTiny(
                objEmpresaMaster.empresa,
                prodMaster.id,
                "S",
                qtdAbs,
                idDepMaster,
                empresaFilial.empresa, 0, observarPostEfetivo
            );

            // Entrada na Filial
            postagemEmAndamento = { etapa: "entrada_filial", empresa: empresaFilial.empresa };
            const respEntrada = await editEstoqueProdTiny(
                empresaFilial.empresa,
                prodFilial.id,
                "E",
                qtdAbs,
                idDepFilial,
                objEmpresaMaster.empresa, 0, observarPostEfetivo
            );

            // ✅ Só grava depois que as duas deram OK
            const idLancSaida = extrairIdLancamento(respSaida);
            const idLancEntrada = extrairIdLancamento(respEntrada);

            // ✅ HISTÓRICO opcional (evita qualquer acesso/uso quando desligado)
            if (historyDbConfig.enabled) {
                const idEmpresaMasterDb = await resolveCompanyIdForHistory(objEmpresaMaster.empresa);
                const idEmpresaFilialDb = await resolveCompanyIdForHistory(empresaFilial.empresa);

                await registrarTransferenciaParNoDb(
                    {
                        idProdutoTiny: prodMaster.id,
                        skuProduto: String(sku),
                        nomeProduto: prodMaster.descricao,
                        quantidade: qtdAbs,

                        empresaEntradaId: idEmpresaFilialDb,
                        empresaSaidaId: idEmpresaMasterDb,

                        idLancamento: idLancSaida,
                        tipoLancamento: "S",
                    },
                    {
                        idProdutoTiny: prodFilial.id,
                        skuProduto: String(sku),
                        nomeProduto: prodFilial.descricao,
                        quantidade: qtdAbs,

                        empresaEntradaId: idEmpresaFilialDb,
                        empresaSaidaId: idEmpresaMasterDb,

                        idLancamento: idLancEntrada,
                        tipoLancamento: "E",
                    }
                );
            }
        }

        console.log(`[✔️ SUCESSO!] Transferência do SKU ${String(p.codigo_sku)} concluída.`);
        return true;
    } catch (err: unknown) {
        const error = err as Partial<TinyApiError> & { message?: string };

        if (error?.name === "TinyApiError") {
            if (error.method === "GET" && consultaEmAndamento) {
                rastreioTransferencia.consultasProduto[consultaEmAndamento].resultado = {
                    sucesso: false, status: error.status ?? null, responseData: error.responseData,
                };
                if (error.url) rastreioTransferencia.consultasProduto[consultaEmAndamento].url = error.url;
            }
            if (error.method === "POST") {
                const corpoErro = (error.requestData && typeof error.requestData === "object" && !Array.isArray(error.requestData)) ? error.requestData as Record<string, unknown> : {};
                if (postagemEmAndamento && indicesTentativasPost.size === 0) {
                    rastreioTransferencia.movimentacoes.push({ ...postagemEmAndamento, url: error.url ?? "URL não informada", body: corpoErro, resultado: { sucesso: false, status: error.status, responseData: error.responseData } });
                }
            }
            const diagnostico = construirDiagnosticoTransferencia(rastreioTransferencia);
            console.error(`❌ Falha de API ao processar o SKU: ${String(p.codigo_sku)}.`);
            console.error("   - Diagnóstico da transferência (dados sanitizados):");
            console.error(JSON.stringify(diagnostico, null, 2));
            registrarProblemaHomologacao({
                tipo: "erro_api_tiny",
                sku: String(p.codigo_sku),
                empresa: (postagemEmAndamento?.empresa === objEmpresaMaster.empresa || consultaEmAndamento === "master") ? objEmpresaMaster.empresa : empresaFilial.empresa,
                nomeEmpresa: (postagemEmAndamento?.empresa === objEmpresaMaster.empresa || consultaEmAndamento === "master") ? objEmpresaMaster.nomeEmpresa : empresaFilial.nomeEmpresa,
                mensagem: error.message ?? `Falha de API Tiny ao processar SKU ${String(p.codigo_sku)}.`,
                status: error.status ?? null,
                url: error.url ?? null,
                dados: diagnostico,
            });

            if (error.status === 404) {
                console.warn(
                    `   - Causa Provável: O ID de um produto ou depósito não foi encontrado durante a movimentação.`
                );
            }

            await sendMessageMain(`❌ Falha de API ao processar o SKU: ${String(p.codigo_sku)}.
- Status: ${String(error.status)}. Consulte o relatório de homologação para o diagnóstico sanitizado da transferência.`);
        } else {
            const diagnostico = construirDiagnosticoTransferencia(rastreioTransferencia);
            const empresaComFalha = (postagemEmAndamento?.empresa === objEmpresaMaster.empresa || consultaEmAndamento === "master")
                ? objEmpresaMaster
                : empresaFilial;
            console.error(
                `❌ Ocorreu um erro inesperado no processamento do SKU ${String(p.codigo_sku)}:`,
                error?.message ?? error
            );
            if (rastreioTransferencia.movimentacoes.length > 0 || consultaEmAndamento) {
                console.error("   - Diagnóstico da transferência (dados sanitizados):");
                console.error(JSON.stringify(diagnostico, null, 2));
            }
            registrarProblemaHomologacao({
                tipo: "erro_inesperado",
                sku: String(p.codigo_sku),
                empresa: empresaComFalha.empresa,
                nomeEmpresa: empresaComFalha.nomeEmpresa,
                mensagem: error?.message ?? String(error),
                dados: {
                    diagnostico_transferencia: diagnostico,
                },
            });
            await sendMessageMain(
                `❌ Ocorreu um erro inesperado no processamento do SKU ${String(p.codigo_sku)}: ${error?.message ?? String(error)
                }`
            );
        }

        console.warn("   ➡️  Ação: A transferência para este produto foi cancelada. Pulando para o próximo.");
        registrarProblemaHomologacao({
            tipo: "transferencia_cancelada",
            sku: String(p.codigo_sku),
            empresa: empresaFilial.empresa,
            nomeEmpresa: empresaFilial.nomeEmpresa,
            mensagem: "A transferência para este produto foi cancelada. Pulando para o próximo.",
        });
        await sendMessageMain("➡️  Ação: A transferência para este produto foi cancelada. Pulando para o próximo.");
        return false;
    }
}

export async function sendMessageMain(
    text: string,
    instance: string = instanceWhatsApp[0],
    linkPreview: boolean = false,
    idempotencyKey: string = randomUUID()
): Promise<boolean> {
    if (listaTelefones.length === 0) return true;

    for (const number of listaTelefones) {
        const obj: SendMessagePayload = {
            number,
            text,
            instance,
            linkPreview,
            idempotencyKey,
        };

        try {
            if (await sendMessage(obj)) return true;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`❌ Falha ao enviar WhatsApp para ${number}: ${message}`);
            registrarProblemaHomologacao({
                tipo: "erro_whatsapp",
                mensagem: message,
                dados: {
                    number,
                    instance,
                    linkPreview,
                },
            }, { resumoValor: `${number}: ${message}` });
        }
    }

    return false;
}

// Controle simples pra não spammar WhatsApp
let _infoWhatsAppCount = 0;
const INFO_WHATSAPP_LIMIT = Number(process.env.INFO_WHATSAPP_LIMIT ?? 40); // ajuste no .env se quiser

async function logInfo(msg: string, enviarWhatsApp: boolean = true): Promise<void> {
    console.log(`[INFO] ${msg}`);

    if (!enviarWhatsApp) return;
    if (_infoWhatsAppCount >= INFO_WHATSAPP_LIMIT) return;

    _infoWhatsAppCount++;
    await sendMessageMain(`ℹ️ ${msg}`);
}

// Outras lógicas de inicialização podem ser adicionadas aqui
process.on("uncaughtException", (err: Error) => {
    iniciarRelatorioHomologacao();
    registrarProblemaHomologacao({
        tipo: "erro_inesperado",
        contexto: "uncaughtException",
        mensagem: err.message,
        dados: { stack: err.stack },
    });
    finalizarRelatorioHomologacao("finalizado_com_erros");
    console.error("❌ Erro fatal não tratado:", err);
    process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    iniciarRelatorioHomologacao();
    registrarProblemaHomologacao({
        tipo: "erro_inesperado",
        contexto: "unhandledRejection",
        mensagem: message,
        dados: reason instanceof Error ? { stack: reason.stack } : { reason },
    });
    finalizarRelatorioHomologacao("finalizado_com_erros");
    console.error("❌ Promise rejeitada sem tratamento:", reason);
    process.exit(1);
});

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    iniciarRelatorioHomologacao();
    registrarProblemaHomologacao({
        tipo: "erro_inesperado",
        contexto: "main",
        mensagem: message,
        dados: err instanceof Error ? { stack: err.stack } : { err },
    });
    finalizarRelatorioHomologacao("finalizado_com_erros");
    console.error("❌ Erro fatal na execução:", err);
    process.exit(1);
});
