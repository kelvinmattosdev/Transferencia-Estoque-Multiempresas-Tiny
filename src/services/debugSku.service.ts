export type DebugSkuRow = {
    codigo_sku?: string | number | null;
    estoque_atual: number;
};

function normalizarSku(valor: unknown): string {
    return String(valor ?? "").trim().toUpperCase();
}

/** Lê DEBUG_SKU=SKU1 ou DEBUG_SKU=SKU1,SKU2 do ambiente. */
export function obterDebugSkus(valor = process.env.DEBUG_SKU): Set<string> | null {
    const bruto = valor?.trim();
    if (!bruto || bruto.toUpperCase() === "NONE") return null;

    const skus = bruto.split(",").map(normalizarSku).filter(Boolean);
    return skus.length > 0 ? new Set(skus) : null;
}

export function filtrarPorDebugSku<T extends DebugSkuRow>(linhas: T[], skus: Set<string> | null): T[] {
    if (!skus) return linhas;
    return linhas.filter((linha) => skus.has(normalizarSku(linha.codigo_sku)));
}

export function formatarDebugSkus(skus: Set<string>): string {
    return [...skus].join(", ");
}
