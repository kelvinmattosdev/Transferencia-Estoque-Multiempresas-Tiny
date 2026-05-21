// src/services/sendMessage.service.ts

import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import { configDotenv } from "dotenv";

configDotenv();

// 👉 Config principal
const EVO_BASE_URL: string = process.env.EVO_BASE_URL || "";
const EVO_API_KEY: string = (process.env.EVO_API_KEY || "").trim(); // remove espaços acidentais

// ⚠️ EvolutionAPI usa header "apikey" (minúsculo)
const api: AxiosInstance = axios.create({
    baseURL: EVO_BASE_URL,
    headers: { apikey: EVO_API_KEY },
    timeout: 10_000, // 10s
});

// Logger simples e seguro (sem vazar segredos)
function logInfo(event: string, payload: Record<string, unknown> = {}): void {
    console.log(
        JSON.stringify({
            level: "info",
            ts: new Date().toISOString(),
            event,
            ...payload,
        })
    );
}
function logError(event: string, payload: Record<string, unknown> = {}): void {
    console.error(
        JSON.stringify({
            level: "error",
            ts: new Date().toISOString(),
            event,
            ...payload,
        })
    );
}

function getResponseMessage(data: unknown): string | null {
    if (!data || typeof data !== "object") return null;

    const response = (data as { response?: unknown }).response;
    if (response && typeof response === "object") {
        const message = (response as { message?: unknown }).message;
        if (Array.isArray(message)) return message.map(String).join(" | ");
        if (message) return String(message);
    }

    const message = (data as { message?: unknown; error?: unknown }).message;
    if (Array.isArray(message)) return message.map(String).join(" | ");
    if (message) return String(message);

    const error = (data as { error?: unknown }).error;
    return error ? String(error) : null;
}

function formatAxiosError(err: unknown, context: Record<string, unknown>): string {
    if (!axios.isAxiosError(err)) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ ...context, message }, null, 2);
    }

    const responseData = err.response?.data ?? null;
    return JSON.stringify(
        {
            ...context,
            message: err.message,
            code: err.code ?? null,
            http_status: err.response?.status ?? null,
            http_status_text: err.response?.statusText ?? null,
            api_message: getResponseMessage(responseData),
            response: responseData,
        },
        null,
        2
    );
}

// Sanitiza e valida número (E.164-like: só dígitos, exige DDI+DDD, mínimo 10 dígitos)
function sanitizeNumber(input: unknown): string {
    const digits = String(input ?? "").replace(/\D/g, "");
    if (digits.length < 10) {
        throw new Error(
            `Número inválido: "${String(input)}" -> "${digits}" (mínimo 10 dígitos com DDI+DDD)`
        );
    }
    return digits;
}

type RetryOptions = {
    retries?: number;
    baseDelayMs?: number;
};

// Retry com backoff exponencial (sem lib externa)
async function withRetry<T>(
    fn: () => Promise<T>,
    { retries = 3, baseDelayMs = 400 }: RetryOptions = {}
): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;

    while (attempt <= retries) {
        try {
            return await fn();
        } catch (err: unknown) {
            lastErr = err;

            const e = err as {
                code?: string;
                response?: { status?: number };
            };

            const status = e?.response?.status;

            const retryable =
                // timeouts, resets, DNS, etc.
                e?.code === "ECONNABORTED" ||
                e?.code === "ENOTFOUND" ||
                e?.code === "ECONNRESET" ||
                // 5xx do servidor
                (typeof status === "number" && status >= 500 && status < 600) ||
                // 429 rate limit
                status === 429;

            if (!retryable || attempt === retries) break;

            const delay = Math.round(baseDelayMs * Math.pow(2, attempt) + Math.random() * 100);
            logInfo("retry_scheduled", { attempt: attempt + 1, delay_ms: delay, status });
            await new Promise < void> ((r) => setTimeout(r, delay));
            attempt++;
        }
    }

    throw lastErr;
}

export type SendMessageParams = {
    number: string | number;
    text: string;
    instance?: string;
    linkPreview?: boolean;
    idempotencyKey?: string;
};

export type SendMessageResult = {
    ok: true;
    status: number;
    data: unknown;
};

/**
 * Envia texto via EvolutionAPI
 * @param params.number - número com DDI+DDD (apenas dígitos ou formatado; será sanitizado)
 * @param params.text - conteúdo da mensagem
 * @param params.instance - nome da instância
 * @param params.linkPreview - preview de links
 * @param params.idempotencyKey - força idempotência no backend (se suportado)
 */
export async function sendMessage({
    number,
    text,
    instance = "meu-whats",
    linkPreview = false,
    idempotencyKey,
}: SendMessageParams): Promise<SendMessageResult> {
    const to = sanitizeNumber(number);

    const body = {
        number: to,
        text: String(text ?? ""),
        linkPreview: Boolean(linkPreview),
    };

    if (!body.text.trim()) throw new Error("Texto vazio.");

    const url = `/message/sendText/${encodeURIComponent(instance)}`;
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers["x-idempotency-key"] = String(idempotencyKey);

    const start = Date.now();

    try {
        const resp = await withRetry < AxiosResponse < unknown >> (
            () => api.post(url, body, { headers }),
            { retries: 3, baseDelayMs: 400 }
        );

        const elapsedMs = Date.now() - start;
        const data = resp?.data ?? {};

        const d = data as any;
        const messageId: string | null = d?.messageId ?? d?.id ?? null;
        const messageStatus: string = d?.status ?? d?.message?.status ?? "UNKNOWN";

        logInfo("send_text_success", {
            to,
            instance,
            http_status: resp.status,
            message_status: messageStatus,
            message_id: messageId,
            elapsed_ms: elapsedMs,
        });

        return { ok: true, status: resp.status, data };
    } catch (err: unknown) {
        const elapsedMs = Date.now() - start;

        const status = axios.isAxiosError(err) ? err.response?.status ?? null : null;
        const responseData = axios.isAxiosError(err) ? err.response?.data ?? null : null;
        const apiMessage = getResponseMessage(responseData);

        logError("send_text_error", {
            to,
            instance,
            http_status: status,
            code: axios.isAxiosError(err) ? err.code ?? null : null,
            elapsed_ms: elapsedMs,
            api_message: apiMessage,
            response: responseData,
        });

        console.error(
            "❌ Erro detalhado ao enviar WhatsApp:\n" +
            formatAxiosError(err, {
                method: "POST",
                url,
                instance,
                to,
                elapsed_ms: elapsedMs,
            })
        );

        const friendly = new Error(
            status
                ? `Falha ao enviar WhatsApp (HTTP ${status})${apiMessage ? `: ${apiMessage}` : "."}`
                : `Falha ao enviar WhatsApp (erro de rede/timeout).`
        );
        throw friendly;
    }
}
