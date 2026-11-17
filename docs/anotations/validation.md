# Validação

| Data | Critério | Evidência | Resultado |
| --- | --- | --- | --- |
| 2026-09-21 | Artefato SC disponível para análise | `find data -maxdepth 1 -type f -printf '%f %s bytes'` identificou `inventario-sc.xls` com 0 bytes | FAIL |
| 2026-09-21 | URL usada pelo código localizada | `src/services/tinyPuppeteer.service.ts:260-264` | PASS |
| 2026-09-21 | ID de depósito chega ao downloader sem alteração | Explorer: `src/config/index.ts:303-314`, `src/main.ts:245-270` | PASS |
| 2026-09-21 | Login automatizado confirma tenant/empresa antes do download | Explorer: `src/services/tinyPuppeteer.service.ts:217-258` usa espera fixa/cookies, sem asserção de rota ou identidade | FAIL |
| 2026-09-21 | XLS estruturalmente válido com todos os saldos zero é sinalizado | Explorer: `src/services/spreadsheetDownload.service.ts:39-73` só valida estrutura | FAIL |
| 2026-09-21 | Cada tentativa usa sessão isolada e descarta dados no encerramento | Revisão independente: `src/services/tinyPuppeteer.service.ts` cria `BrowserContext`, limpa dados antes do login e no `finally`, depois fecha contexto/browser | PASS (revisão estática) |
| 2026-09-21 | Inventário válido com saldos todos zero gera alerta sem bloquear | `node tests/spreadsheetDownload.test.mjs`: teste `aceita relatório válido...` | PASS |
| 2026-09-21 | Testes e compilação | `npm test` — 7 testes de planilha + 3 de DEBUG_SKU aprovados | PASS |
| 2026-09-21 | Consistência do diff | `git diff --check` | PASS |
| 2026-09-22 | Ordem e payload da transferência negativa JP → SC | Inspeção estática Explorer: `src/main.ts:713-731`, `src/services/tinyApi.service.ts:188-217` | PASS |
| 2026-09-22 | Entrada SC recebe depósito reconhecido pelo token SC | Log do usuário: HTTP 400 `deposito.id` não encontrado | FAIL |
| 2026-09-22 | Falha na entrada compensa saída já lançada | Inspeção estática Explorer: não há reversão após o primeiro POST | FAIL |
| 2026-09-22 | Diagnóstico atribui POST com falha à empresa correta | QA/revisão: `main.ts` rotulava toda falha como filial | FAIL — em correção |
| 2026-09-22 | Diagnóstico mostra corpo efetivamente enviado e GET/resposta resumida | QA/revisão: corpo reconstruído sem data e GET sem status/resposta explícita | FAIL — em correção |
| 2026-09-22 | Relatório externo atribui a falha à empresa correta | QA: campo externo ainda usa filial mesmo se a master falhar | FAIL — em correção |
| 2026-09-22 | Rastro de POST representa retentativas sem etapas fantasma | Revisor: observador é chamado por tentativa, mas apenas resultado final era concluído | FAIL — em correção |
| 2026-09-22 | Diagnóstico de erro mostra origem de IDs, GET/POST/respostas e preserva segredos | `node tests/transferDiagnostic.test.mjs` — 7 testes aprovados | PASS |
| 2026-09-22 | Empresa/etapa e retentativas no relatório são precisas | QA/revisor: inspeção estática de `main.ts`/`tinyApi.service.ts`, testes de master e 401→201 | PASS |
| 2026-09-22 | Suíte de regressão | `npm test` — 17 testes aprovados | PASS |
