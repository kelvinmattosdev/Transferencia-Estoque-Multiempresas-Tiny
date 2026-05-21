import fs from "node:fs";
import path from "node:path";

type ReportStatus = "em_execucao" | "concluido" | "finalizado_com_erros";

type ReportIssue = {
    tipo: string;
    sku?: string | null;
    empresa?: string | null;
    nomeEmpresa?: string | null;
    contexto?: string | null;
    mensagem: string;
    status?: number | string | null;
    url?: string | null;
    responseData?: unknown;
    dados?: Record<string, unknown>;
    registradoEm: string;
};

type HomologacaoReport = {
    metadata: {
        status: ReportStatus;
        iniciadoEm: string;
        atualizadoEm: string;
        finalizadoEm: string | null;
        comando: string;
        arquivo: string;
    };
    resumo: {
        produto_nao_existe_master: string[];
        produto_nao_existe_filial: string[];
        deposito_nao_definido: string[];
        sku_vazio_planilha: string[];
        estoque_nao_transferivel: string[];
        erro_validacao: string[];
        erro_banco: string[];
        erro_api_tiny: string[];
        erro_whatsapp: string[];
        erro_inesperado: string[];
        transferencia_cancelada: string[];
        [categoria: string]: string[] | undefined;
    };
    detalhes: ReportIssue[];
};

const defaultReportPath = path.resolve(process.cwd(), "data", "homologacao-relatorio.json");
const reportPath = path.resolve(process.env.HOMOLOGACAO_REPORT_PATH || defaultReportPath);

const report: HomologacaoReport = {
    metadata: {
        status: "em_execucao",
        iniciadoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString(),
        finalizadoEm: null,
        comando: process.argv.join(" "),
        arquivo: reportPath,
    },
    resumo: {
        produto_nao_existe_master: [],
        produto_nao_existe_filial: [],
        deposito_nao_definido: [],
        sku_vazio_planilha: [],
        estoque_nao_transferivel: [],
        erro_validacao: [],
        erro_banco: [],
        erro_api_tiny: [],
        erro_whatsapp: [],
        erro_inesperado: [],
        transferencia_cancelada: [],
    },
    detalhes: [],
};

let initialized = false;

function sanitizeKeyPart(value: string): string {
    return value
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function ensureCategory(category: string): string[] {
    const current = report.resumo[category];
    if (Array.isArray(current)) return current;

    report.resumo[category] = [];
    return report.resumo[category] as string[];
}

function addUnique(category: string, value: string): void {
    const list = ensureCategory(category);
    if (!list.includes(value)) list.push(value);
}

function saveReport(): void {
    report.metadata.atualizadoEm = new Date().toISOString();
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
        reportPath,
        JSON.stringify(
            {
                metadata: report.metadata,
                ...report.resumo,
                detalhes: report.detalhes,
            },
            null,
            2
        ) + "\n",
        "utf8"
    );
}

export function iniciarRelatorioHomologacao(): void {
    if (initialized) return;
    initialized = true;
    saveReport();
    console.log(`🧾 Relatório de homologação: ${reportPath}`);
}

export function registrarProdutoNaoExiste(params: {
    sku: string | number;
    escopo: "master" | "filial";
    empresa: string;
    nomeEmpresa: string;
    mensagem?: string;
}): void {
    const sku = String(params.sku);
    const categoria =
        params.escopo === "master"
            ? "produto_nao_existe_master"
            : `produto_nao_existe_filial_${sanitizeKeyPart(params.empresa)}`;

    addUnique(categoria, sku);
    if (params.escopo === "filial") addUnique("produto_nao_existe_filial", sku);
    registrarProblemaHomologacao({
        tipo: categoria,
        sku,
        empresa: params.empresa,
        nomeEmpresa: params.nomeEmpresa,
        contexto: params.escopo,
        mensagem:
            params.mensagem ??
            `Produto ${sku} não existe na conta ${params.nomeEmpresa} (${params.empresa}).`,
    });
}

export function registrarProblemaHomologacao(
    issue: Omit<ReportIssue, "registradoEm">,
    options: { resumoValor?: string | number | null; adicionarNoResumo?: boolean } = {}
): void {
    if (options.adicionarNoResumo !== false) {
        const resumoValor = options.resumoValor ?? issue.sku ?? issue.mensagem;
        if (resumoValor !== undefined && resumoValor !== null) {
            addUnique(issue.tipo, String(resumoValor));
        }
    }

    report.detalhes.push({
        ...issue,
        registradoEm: new Date().toISOString(),
    });
    saveReport();
}

export function prepararCategoriasEmpresasHomologacao(
    empresas: Array<{ empresa: string; isMaster?: boolean }>
): void {
    for (const empresa of empresas) {
        if (empresa.isMaster) continue;
        ensureCategory(`produto_nao_existe_filial_${sanitizeKeyPart(empresa.empresa)}`);
    }
    saveReport();
}

export function finalizarRelatorioHomologacao(status: ReportStatus = "concluido"): void {
    report.metadata.status = status;
    report.metadata.finalizadoEm = new Date().toISOString();
    saveReport();
}

export function getRelatorioHomologacaoPath(): string {
    return reportPath;
}
