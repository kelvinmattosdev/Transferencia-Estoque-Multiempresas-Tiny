// ### ./src/services/tinyPuppeteer.service.ts ###

import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext } from "puppeteer";
import { sendMessageMain } from "../main.js";
import type { Page } from "puppeteer-core"; // pode colocar junto com os imports
import { baixarPlanilhaComValidacao } from "./spreadsheetDownload.service.js";

function isFrameDetachedError(e: unknown): boolean {
    const msg = (e as any)?.message ? String((e as any).message) : String(e);
    return msg.includes("Navigating frame was detached") || msg.includes("LifecycleWatcher disposed");
}

function isSelectorNotFoundError(e: unknown): boolean {
    const msg = (e as any)?.message ? String((e as any).message) : String(e);
    return (
        msg.includes("Waiting for selector") ||
        msg.toLowerCase().includes("nao achei o selector") ||
        msg.toLowerCase().includes("não achei o selector")
    );
}

async function preencherInput(
    page: Page,
    selector: string,
    value: string,
    label: string
): Promise<void> {
    // Garante que o input está visível e interativo
    await page.waitForFunction(
        (sel) => {
            const el = document.querySelector(sel) as HTMLInputElement | null;
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const visivel = style.visibility !== "hidden" && style.display !== "none";
            return visivel && !el.disabled && !el.readOnly;
        },
        { timeout: 20_000 },
        selector
    );

    const input = await page.waitForSelector(selector, { visible: true, timeout: 20_000 });
    if (!input) {
        throw new Error(`Input não encontrado para ${label}: ${selector}`);
    }

    await input.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await input.type(value, { delay: 100 });

    // Verifica se o valor realmente entrou (às vezes o foco se perde)
    const atual = await page.$eval(selector, (el) => (el as HTMLInputElement).value);
    if (!atual) {
        // Fallback: seta via JS e dispara eventos para o React/DOM
        await page.$eval(
            selector,
            (el, v) => {
                const inputEl = el as HTMLInputElement;
                inputEl.focus();
                inputEl.value = String(v);
                inputEl.dispatchEvent(new Event("input", { bubbles: true }));
                inputEl.dispatchEvent(new Event("change", { bubbles: true }));
            },
            value
        );
        console.log(`⚠️ ${label} preenchido via fallback JS.`);
    }
}

async function salvarScreenshotDebug(
    page: Page | null,
    reason: string
): Promise<string | null> {
    if (!page) return null;

    try {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const fileName = `debug-${reason}-${ts}.png`;
        const filePath = path.resolve(process.cwd(), fileName) as `${string}.png`;
        await page.screenshot({ path: filePath, fullPage: true });
        console.log(`🧾 Screenshot salva em: ${filePath}`);
        return filePath;
    } catch (err: unknown) {
        const e = err as { message?: string };
        console.error("❌ Erro ao salvar screenshot de debug:", e?.message ?? String(err));
        return null;
    }
}

async function gotoWithRetry(
    page: Page,
    url: string,
    tries = 3
): Promise<void> {
    let lastErr: unknown;

    for (let i = 1; i <= tries; i++) {
        try {
            // domcontentloaded é bem mais estável que networkidle2 em SPA/login
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
            return;
        } catch (e) {
            lastErr = e;

            if (!isFrameDetachedError(e) || i === tries) {
                throw e;
            }

            // pequeno backoff e tenta de novo
            await new Promise<void>((r) => setTimeout(r, 800 * i));
        }
    }

    throw lastErr ?? new Error("Falha desconhecida em gotoWithRetry");
}

// puppeteer-extra às vezes não expõe typings completos (use/launch) dependendo do setup TS.
// Então tipamos o wrapper como any e mantemos Browser vindo do puppeteer (tipagem correta).
const puppeteer = puppeteerExtra as any;

puppeteer.use(StealthPlugin()); // Ativa o modo stealth

// Função auxiliar para fechar o navegador
async function _encerrarExecucao(browser: Browser | null): Promise<void> {
    if (!browser) return;

    try {
        await browser.close();
        console.log("🧯 Navegador Puppeteer fechado.");
    } catch (e: unknown) {
        const err = e as { message?: string };
        console.error("❌ Erro ao fechar o navegador:", err?.message ?? String(e));
    }
}

/**
 * O download de cada empresa/tentativa deve partir de uma sessão totalmente nova.
 * O contexto isolado já não compartilha dados com outros contextos; a limpeza
 * explícita também elimina qualquer dado criado antes do formulário de login.
 */
async function limparDadosDeAutenticacao(page: Page): Promise<void> {
    const client = await page.target().createCDPSession();
    const origins = [
        "https://erp.tiny.com.br",
        "https://tiny.com.br",
        "https://erp.olist.com",
        "https://olist.com",
    ];

    try {
        const cookies = await page.cookies();
        if (cookies.length > 0) {
            await page.deleteCookie(...cookies);
        }

        await client.send("Network.clearBrowserCookies");
        await client.send("Network.clearBrowserCache");

        for (const origin of origins) {
            await client.send("Storage.clearDataForOrigin", {
                origin,
                storageTypes: "all",
            });
        }

        console.log("🧼 Dados de autenticação do Tiny/Olist removidos do contexto isolado.");
    } finally {
        await client.detach().catch(() => { });
    }
}

// Função auxiliar só para caçar o caminho do Chrome
function resolveChromePath(): string | undefined {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const candidates = [
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
    ];

    return candidates.find((p) => fs.existsSync(p));
}

/**
 * Realiza o login no Tiny ERP e baixa a planilha de inventário de um depósito específico.
 * @param user - Usuário para login no Tiny ERP.
 * @param pass - Senha para login no Tiny ERP.
 * @param idDeposito - ID do depósito.
 * @param outputPath - Caminho completo (incluindo nome do arquivo) onde a planilha será salva.
 * @returns O caminho completo para o arquivo baixado.
 */
async function baixarPlanilhaDepositoUmaTentativa(
    user: string,
    pass: string,
    idDeposito: string | number,
    outputPath: string
): Promise<string> {
    let browser: Browser | null = null;
    let browserContext: BrowserContext | null = null;
    let page: Page | null = null;

    const downloadFilePath = path.resolve(outputPath);
    const outputDir = path.dirname(downloadFilePath);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    try {
        console.log("🚀 Iniciando processo de login...");

        const executablePath = resolveChromePath();
        if (!executablePath) {
            const msg =
                "Chrome/Chromium não encontrado. Defina PUPPETEER_EXECUTABLE_PATH ou instale o navegador.";
            await sendMessageMain(msg);
            throw new Error(msg);
        }

        browser = (await puppeteer.launch({
            // em servidor linux sem GUI, tem que ser headless
            headless: "new",
            executablePath,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                // "--no-zygote",
                // "--single-process",
                "--window-size=1366,768",
            ],
            defaultViewport: { width: 1366, height: 768 },
        })) as Browser;

        // Não use o contexto padrão: cada tentativa recebe um storage partition
        // próprio e é descartada antes de processar a próxima empresa.
        browserContext = await browser.createBrowserContext();
        page = await browserContext.newPage();
        if (!page) {
            throw new Error("Falha ao criar uma nova página do Puppeteer.");
        }

        console.log("🌐 Acessando o site do Tiny...");
        // timeouts padrão (evita travar em coisas do login)
        page.setDefaultTimeout(90_000);
        page.setDefaultNavigationTimeout(90_000);

        await limparDadosDeAutenticacao(page);

        await gotoWithRetry(page, "https://erp.tiny.com.br/login", 3);

        console.log("📝 Preenchendo campo de usuário...");
        await preencherInput(page, "#username", user, "Usuário");
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));

        console.log('➡️ Clicando no botão "Avançar"...');
        // Preferir click via Puppeteer (evita depender de "document" no TS)
        // const selAvancar =
        //     "#kc-content-wrapper > react-login-wc > section > div > main > aside.sc-jsJBEP.hfxeyl > div > button";
        // await page.waitForSelector(selAvancar, { timeout: 20_000 });
        // await page.click(selAvancar);
        // await new Promise<void>((resolve) => setTimeout(resolve, 1000));

        console.log("🔒 Preenchendo a senha...");
        await preencherInput(page, "#password", pass, "Senha");
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));

        console.log('🔓 Clicando no botão "Entrar"...');
        const selEntrar =
            "#kc-content-wrapper > react-login-wc > section > div > main > aside.sc-eeDRCY.gRREyd > div > form > button";
        await page.waitForSelector(selEntrar, { timeout: 20_000 });
        await page.click(selEntrar);
        await new Promise<void>((resolve) => setTimeout(resolve, 5000));

        console.log("🕵️ Verificando se há sessão ativa anterior...");
        const modalSel =
            "#bs-modal-ui-popup > div > div > div > div.modal-footer > button.btn-primary";
        const modalBtn = await page.$(modalSel);
        if (modalBtn) {
            console.log('⚠️ Sessão anterior detectada! Clicando em "Entrar assim mesmo"...');
            await modalBtn.click();
            await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        } else {
            console.log("✅ Nenhuma sessão anterior detectada.");
        }

        console.log("🍪 Extraindo cookies da sessão...");
        const cookies = await page.cookies();
        const cookieHeader = cookies
            .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
            .join("; ");

        const downloadUrl =
            `https://erp.tiny.com.br/relatorios/relatorio.estoque.inventario.download.xls` +
            `?produto=&idDeposito=${encodeURIComponent(String(idDeposito))}` +
            `&idCategoria=0&descricaoCategoria=&exibirSaldo=&idCategoriaFiltro=0&layoutExportacao=R` +
            `&formatoPlanilha=xls&exibirEstoqueDisponivel=N&produtoSituacao=A&idFornecedor=0&valorBaseado=0`;

        console.log(`⬇️ Iniciando download do relatório de ${String(idDeposito)}...`);

        const fileStream = fs.createWriteStream(downloadFilePath);

        await new Promise<void>((resolve, reject) => {
            const options: https.RequestOptions = {
                headers: {
                    Cookie: cookieHeader,
                    "User-Agent": "Mozilla/5.0",
                },
            };

            fileStream.on("error", async (err: unknown) => {
                console.error("❌ Erro ao escrever o arquivo de download.");
                await sendMessageMain("❌ Erro ao escrever o arquivo de download.").catch(() => { });

                try {
                    if (fs.existsSync(downloadFilePath)) fs.unlinkSync(downloadFilePath);
                } catch { }

                reject(new Error("Erro ao salvar o arquivo."));
            });

            const request = https.get(downloadUrl, options, (response) => {
                if (response.statusCode !== 200) {
                    void sendMessageMain(`❌ Falha no download: HTTP ${response.statusCode}`).catch(() => { });
                    response.resume();
                    fileStream.destroy();
                    return reject(new Error(`Falha no download: HTTP ${response.statusCode}`));
                }

                response.pipe(fileStream);

                fileStream.on("finish", () => {
                    try {
                        fileStream.close();
                    } catch { }
                });

                fileStream.on("close", () => {
                    console.log("✅ Download concluído com sucesso!");
                    resolve();
                });
            });

            request.setTimeout(600_000, () => {
                console.error("❌ Timeout de download atingido (10 min).");
                void sendMessageMain("❌ Timeout de download atingido.").catch(() => { });
                request.destroy(new Error("Timeout de download atingido."));

                try {
                    if (fs.existsSync(downloadFilePath)) fs.unlinkSync(downloadFilePath);
                } catch { }

                reject(new Error("Timeout de download atingido. A operação demorou muito."));
            });

            request.on("error", async (err: unknown) => {
                console.error("❌ Erro na requisição HTTPS de download.");
                await sendMessageMain("❌ Erro na requisição de download.").catch(() => { });

                try {
                    if (fs.existsSync(downloadFilePath)) fs.unlinkSync(downloadFilePath);
                } catch { }

                reject(new Error("Erro na requisição de download."));
            });
        });

        return downloadFilePath;
    } catch (e: unknown) {
        if (isSelectorNotFoundError(e)) {
            const screenshotPath = await salvarScreenshotDebug(page, "selector-not-found");
            if (screenshotPath) {
                await sendMessageMain(`🧾 Screenshot salva em: ${screenshotPath}`).catch(() => { });
            }
        }
        console.error("❌ Erro na execução da automação de download.");
        await sendMessageMain("❌ Erro na execução da automação de download.");
        throw e;
    } finally {
        if (page) {
            try {
                await limparDadosDeAutenticacao(page);
            } catch {
                // A limpeza no encerramento não pode mascarar o erro original.
                console.error("❌ Não foi possível limpar os dados de autenticação no encerramento.");
            }
        }
        if (browserContext) {
            try {
                await browserContext.close();
                console.log("🧼 Contexto isolado do Puppeteer descartado.");
            } catch (e: unknown) {
                const err = e as { message?: string };
                console.error("❌ Erro ao descartar o contexto isolado:", err?.message ?? String(e));
            }
        }
        await _encerrarExecucao(browser);
    }
}

/**
 * Faz até três ciclos completos de login, download e validação da planilha.
 * Um retorno desta função garante que o arquivo é legível pelo xlsx e possui
 * as colunas de SKU e estoque esperadas pelo fluxo de transferência.
 */
export async function baixarPlanilhaDeposito(
    user: string,
    pass: string,
    idDeposito: string | number,
    outputPath: string,
    empresa = "desconhecida"
): Promise<string> {
    try {
        return await baixarPlanilhaComValidacao({
            empresa,
            outputPath,
            baixar: () => baixarPlanilhaDepositoUmaTentativa(user, pass, idDeposito, outputPath),
        });
    } catch (erro: unknown) {
        const mensagem = erro instanceof Error ? erro.message : "Falha ao validar a planilha baixada.";
        console.error(`❌ ${mensagem}`);
        await sendMessageMain(`❌ ${mensagem}`).catch(() => { });
        throw erro;
    }
}

/**
 * Remove arquivos com extensões específicas de um diretório.
 * @param dirPath - Caminho do diretório
 * @param allowedExtensions - Lista de extensões a apagar (ex.: ['.csv', '.xlsx'])
 */
export async function limparArquivosPorExtensao(
    dirPath: string,
    allowedExtensions: string[]
): Promise<void> {
    if (!fs.existsSync(dirPath)) {
        console.warn(`⚠️ Diretório não existe: ${dirPath}`);
        return;
    }

    const files = fs.readdirSync(dirPath);

    for (const file of files) {
        const filePath = path.join(dirPath, file);

        try {
            if (fs.lstatSync(filePath).isFile()) {
                const ext = path.extname(file).toLowerCase();
                if (allowedExtensions.includes(ext)) {
                    fs.unlinkSync(filePath);
                    console.log(`🗑️ Removido: ${file}`);
                }
            }
        } catch (e: unknown) {
            const err = e as { message?: string };
            console.error(`❌ Erro ao processar ${file}:`, err?.message ?? String(e));
            await sendMessageMain(`❌ Erro ao processar ${file}: ${err?.message ?? String(e)}`);
        }
    }
}
