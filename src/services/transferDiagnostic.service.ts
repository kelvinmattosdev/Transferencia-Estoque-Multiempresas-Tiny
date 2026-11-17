/**
 * Produz um registro seguro para explicar uma transferência Tiny sem reter
 * segredos de autenticação ou respostas arbitrárias da API.
 */
export type DiagnosticoTransferenciaEntrada = {
    sku: string;
    saldoPlanilha: number;
    consultasProduto: Record<string, {
        empresa: string;
        url: string;
        produtoSelecionado?: { id: string | number; descricao?: string } | null;
        resultado?: { status?: number | string | null; sucesso?: boolean; responseData?: unknown };
    }>;
    depositos: Record<string, { empresa: string; valor: string | number; origem: string }>;
    autenticacao?: Record<string, { empresa: string; origem: string; fonte: "db" | "env" | "desconhecida" }>;
    movimentacoes: Array<{
        etapa: string;
        empresa: string;
        tentativa?: number;
        url: string;
        body: Record<string, unknown>;
        resultado: { status?: number | string | null; responseData?: unknown; sucesso?: boolean };
    }>;
};

const MAX_TEXTO_RESPOSTA = 500;

function limitarTexto(value: unknown): string {
    return String(value ?? "")
        .replace(/\s+/g, " ")
        .replace(/\b(Bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]")
        .replace(/\b(access[_-]?token|token|authorization|cookie|password|senha)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
        .replace(/\b(token|senha|password)\s+[^\s,;]+/gi, "$1 [REDACTED]")
        .trim()
        .slice(0, MAX_TEXTO_RESPOSTA);
}

/** Mantém somente a forma publicada de erros da Tiny; nunca reproduz payload bruto. */
function resumirRespostaTiny(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const response = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    if (typeof response.mensagem === "string") result.mensagem = limitarTexto(response.mensagem);
    if (typeof response.message === "string") result.mensagem = limitarTexto(response.message);

    if (Array.isArray(response.detalhes)) {
        const detalhes = response.detalhes.slice(0, 20).flatMap((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return [];
            const detail = item as Record<string, unknown>;
            const safe: Record<string, string> = {};
            if (typeof detail.campo === "string") safe.campo = limitarTexto(detail.campo);
            if (typeof detail.mensagem === "string") safe.mensagem = limitarTexto(detail.mensagem);
            return Object.keys(safe).length ? [safe] : [];
        });
        if (detalhes.length) result.detalhes = detalhes;
    }

    for (const key of ["idLancamento", "id_lancamento", "idLancamentoEstoque"]) {
        const id = response[key];
        if (typeof id === "string" || typeof id === "number") result[key] = id;
    }

    if (Array.isArray(response.itens)) {
        const itens = response.itens.slice(0, 20).flatMap((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return [];
            const produto = item as Record<string, unknown>;
            if (typeof produto.id !== "string" && typeof produto.id !== "number") return [];
            return [{
                id: produto.id,
                descricao: typeof produto.descricao === "string" ? limitarTexto(produto.descricao) : null,
            }];
        });
        result.itens = itens;
        result.quantidade_itens_retorno = response.itens.length;
    }

    return Object.keys(result).length ? result : null;
}

export function construirDiagnosticoTransferencia(entrada: DiagnosticoTransferenciaEntrada) {
    const consultasProduto = Object.fromEntries(Object.entries(entrada.consultasProduto).map(([papel, consulta]) => [papel, {
        empresa: consulta.empresa,
        requisicao: { metodo: "GET", url: consulta.url },
        produto_selecionado: consulta.produtoSelecionado
            ? {
                id: consulta.produtoSelecionado.id,
                descricao: typeof consulta.produtoSelecionado.descricao === "string"
                    ? limitarTexto(consulta.produtoSelecionado.descricao)
                    : null,
            }
            : null,
        resultado: {
            sucesso: consulta.resultado?.sucesso ?? false,
            status: consulta.resultado?.status ?? null,
            resposta: resumirRespostaTiny(consulta.resultado?.responseData),
        },
    }]));
    const depositos = Object.fromEntries(Object.entries(entrada.depositos).map(([papel, deposito]) => [papel, {
        empresa: deposito.empresa,
        valor: deposito.valor,
        origem_variavel_env: deposito.origem,
    }]));
    const autenticacao = Object.fromEntries(Object.entries(entrada.autenticacao ?? {}).map(([papel, auth]) => [papel, {
        empresa: auth.empresa,
        origem_variavel_env: auth.origem,
        fonte: auth.fonte,
    }]));
    const movimentacoes = entrada.movimentacoes.map((movimentacao) => ({
        etapa: movimentacao.etapa,
        empresa: movimentacao.empresa,
        tentativa: movimentacao.tentativa ?? 1,
        requisicao: { metodo: "POST", url: movimentacao.url },
        corpo_efetivo: movimentacao.body,
        resultado: {
            sucesso: movimentacao.resultado.sucesso ?? false,
            status: movimentacao.resultado.status ?? null,
            resposta: resumirRespostaTiny(movimentacao.resultado.responseData),
        },
    }));

    return {
        sku: entrada.sku,
        origem_planilha: { saldo: entrada.saldoPlanilha },
        consultas_produto: consultasProduto,
        depositos,
        autenticacao,
        movimentacoes,
    };
}
