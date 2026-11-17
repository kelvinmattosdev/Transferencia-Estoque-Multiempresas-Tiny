import assert from "node:assert/strict";
import test from "node:test";
import {
    filtrarPorDebugSku,
    obterDebugSkus,
} from "../build/services/debugSku.service.js";

test("DEBUG_SKU aceita um SKU único", () => {
    assert.deepEqual([...obterDebugSkus("JP1234")], ["JP1234"]);
});

test("DEBUG_SKU aceita lista separada por vírgulas e remove espaços", () => {
    assert.deepEqual([...obterDebugSkus("JP1234, jp4321 ,JP5432")], ["JP1234", "JP4321", "JP5432"]);
});

test("filtra somente SKUs configurados sem alterar o saldo", () => {
    const linhas = [
        { codigo_sku: "JP1234", estoque_atual: 4 },
        { codigo_sku: "OUTRO", estoque_atual: -2 },
        { codigo_sku: "jp4321", estoque_atual: 7 },
    ];
    assert.deepEqual(filtrarPorDebugSku(linhas, obterDebugSkus("JP1234,JP4321")), [linhas[0], linhas[2]]);
});
