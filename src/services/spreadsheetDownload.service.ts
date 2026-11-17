import fs from "node:fs";
import path from "node:path";
import xlsx from "xlsx";

export type PlanilhaValidada = {
    tamanhoBytes: number;
    tipoDetectado: "excel-binario" | "excel-xml" | "html-com-tabela" | "desconhecido";
    aba: string;
    quantidadeItens: number;
    todosEstoquesZerados: boolean;
};

export class PlanilhaDownloadInvalidaError extends Error {
    constructor(public readonly motivo: string) {
        super(motivo);
        this.name = "PlanilhaDownloadInvalidaError";
    }
}

function normalizarCabecalho(valor: unknown): string {
    return String(valor ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, " ")
        .trim()
        .replace(/\s+/g, "_");
}

function detectarTipo(buffer: Buffer): PlanilhaValidada["tipoDetectado"] {
    const inicio = buffer.subarray(0, 2048).toString("utf8").trimStart().toLowerCase();
    if (inicio.startsWith("<!doctype html") || inicio.startsWith("<html") || inicio.startsWith("<script")) {
        return "html-com-tabela";
    }
    if (buffer.subarray(0, 8).toString("hex").startsWith("d0cf11e0a1b11ae1")) return "excel-binario";
    if (buffer.subarray(0, 2).toString() === "PK") return "excel-xml";
    return "desconhecido";
}

function estoqueEhZero(valor: unknown): boolean {
    if (typeof valor === "number") return Number.isFinite(valor) && valor === 0;
    const texto = String(valor ?? "").trim();
    if (!texto) return false;

    const numeroDireto = Number(texto);
    if (Number.isFinite(numeroDireto)) return numeroDireto === 0;

    const numeroPtBr = Number(texto.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(numeroPtBr) && numeroPtBr === 0;
}

/** Valida o conteúdo que o fluxo de transferência realmente precisa consumir. */
export function validarPlanilhaInventario(filePath: string): PlanilhaValidada {
    const absoluto = path.resolve(filePath);
    if (!fs.existsSync(absoluto)) throw new PlanilhaDownloadInvalidaError("arquivo não encontrado");

    const tamanhoBytes = fs.statSync(absoluto).size;
    if (tamanhoBytes <= 0) throw new PlanilhaDownloadInvalidaError("arquivo vazio");

    const buffer = fs.readFileSync(absoluto);
    const tipoDetectado = detectarTipo(buffer);
    const inicio = buffer.subarray(0, 4096).toString("utf8").toLowerCase();
    if (tipoDetectado === "html-com-tabela" && !/<table[\s>]/i.test(inicio)) {
        throw new PlanilhaDownloadInvalidaError("HTML sem tabela (possível login, erro ou redirecionamento)");
    }

    let workbook: xlsx.WorkBook;
    try {
        workbook = xlsx.read(buffer, { type: "buffer", cellDates: true });
    } catch {
        throw new PlanilhaDownloadInvalidaError("conteúdo não interpretável pela biblioteca xlsx");
    }

    const aba = workbook.SheetNames[0];
    const worksheet = aba ? workbook.Sheets[aba] : undefined;
    if (!worksheet) throw new PlanilhaDownloadInvalidaError("planilha sem aba legível");

    const linhas = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: true }) as unknown[][];
    const cabecalhos = (linhas[0] ?? []).map(normalizarCabecalho);
    if (linhas.length < 2 || cabecalhos.length < 6) {
        throw new PlanilhaDownloadInvalidaError("planilha sem linhas ou colunas de inventário suficientes");
    }
    if (cabecalhos[1] !== "codigo_sku" || cabecalhos[5] !== "estoque_atual") {
        throw new PlanilhaDownloadInvalidaError("estrutura de inventário inválida (SKU/estoque atual ausentes)");
    }

    const itens = linhas.slice(1).filter((linha) => String(linha[1] ?? "").trim() !== "");
    return {
        tamanhoBytes,
        tipoDetectado,
        aba,
        quantidadeItens: itens.length,
        todosEstoquesZerados: itens.length > 0 && itens.every((linha) => estoqueEhZero(linha[5])),
    };
}

export type DownloadComValidacaoOptions = {
    empresa: string;
    outputPath: string;
    baixar: () => Promise<string>;
    maxTentativas?: number;
    log?: (mensagem: string) => void;
};

function removerArquivo(filePath: string): void {
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
        // O erro de download/validação abaixo é mais útil e não revela caminhos ou conteúdo.
    }
}

/**
 * Isola arquivo antigo, baixa e só devolve o caminho após validar o parser e o
 * layout esperado. A função `baixar` deve incluir uma nova autenticação.
 */
export async function baixarPlanilhaComValidacao({
    empresa,
    outputPath,
    baixar,
    maxTentativas = 3,
    log = console.log,
}: DownloadComValidacaoOptions): Promise<string> {
    const destino = path.resolve(outputPath);
    let ultimoMotivo = "falha desconhecida";

    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
        removerArquivo(destino);
        log(`⬇️ [${empresa}] Download da planilha: tentativa ${tentativa}/${maxTentativas}.`);
        try {
            const caminhoBaixado = await baixar();
            const metadados = validarPlanilhaInventario(caminhoBaixado);
            log(`✅ [${empresa}] Planilha validada na tentativa ${tentativa}/${maxTentativas} (tamanho=${metadados.tamanhoBytes}, tipo=${metadados.tipoDetectado}, aba=${metadados.aba}).`);
            if (metadados.todosEstoquesZerados) {
                const unidadeItem = metadados.quantidadeItens === 1 ? "item" : "itens";
                log(`⚠️ [${empresa}] Alerta: relatório válido com ${metadados.quantidadeItens} ${unidadeItem}; todos os estoques zerados.`);
            }
            return caminhoBaixado;
        } catch (erro: unknown) {
            ultimoMotivo = erro instanceof PlanilhaDownloadInvalidaError
                ? erro.motivo
                : "falha no download ou na autenticação";
            const tamanho = fs.existsSync(destino) ? fs.statSync(destino).size : 0;
            console.error(`❌ [${empresa}] Tentativa ${tentativa}/${maxTentativas} rejeitada (tamanho=${tamanho}, motivo=${ultimoMotivo}).`);
            removerArquivo(destino);
        }
    }

    throw new PlanilhaDownloadInvalidaError(
        `Empresa ${empresa}: a planilha não pôde ser obtida em formato válido após ${maxTentativas} tentativas (${ultimoMotivo}). Nenhuma movimentação de estoque foi enviada.`
    );
}
