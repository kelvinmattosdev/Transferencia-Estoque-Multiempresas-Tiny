# Worklog

## 2026-09-21 — Gate 0 / diagnóstico de inventário

- Pedido: auditar se a URL e o fluxo de sessão explicam saldos zerados na planilha automatizada.
- Estado local observado: `data/inventario-sc.xls` existe com 0 bytes; não há artefato válido para comparar conteúdo.
- Ações seguras: leitura do endpoint no código, início de análises Explorer e Planner, sem login, download, transferência ou leitura de segredos.

## 2026-09-21 — Gate 1 / descoberta e plano

- Explorer e Planner, em modo somente-leitura, confirmaram que `idDeposito` é interpolado sem substituição.
- Ambos identificaram a lacuna: pós-login não é validado e a requisição Node usa somente cookies extraídos do browser; uma planilha XLS válida com estoque todo zero passa pela validação.
- Próximo gate bloqueado por decisão de produto: tratar um relatório todo zerado como alerta ou erro impeditivo.

## 2026-09-21 — Gate 2 / isolamento de sessão

- Usuário aprovou a mudança para encerrar e limpar dados de autenticação a cada conta.
- Foco de implementação: `src/services/tinyPuppeteer.service.ts`; validação planejada sem login real nem movimentações.

## 2026-09-21 — Regra de alerta para inventário zerado

- Usuário definiu que inventário todo zerado é possível, embora incomum.
- Próxima fatia: incluir contagem de saldos não zero na validação e aviso de possível inconsistência quando a contagem for zero, sem transformar o caso em erro.

## 2026-09-21 — Gates 2 e 3 / entrega validada

- Implementador adicionou `BrowserContext` isolado por tentativa, limpeza de cookies/cache/storage Tiny/Olist antes do login e no `finally`, seguida de descarte do contexto e encerramento do browser.
- Implementador adicionou metadados de inventário e alerta sanitizado para relatório válido com todos os saldos zero; há teste focal de aceitação sem bloqueio.
- QA e revisão independentes aprovaram a alteração. Limitação: não foi executada autenticação real nem teste automatizado de CDP/Puppeteer; a sequência foi comprovada por revisão estática, compilação e testes locais.

## 2026-09-22 — Inspeção da requisição de estoque

- Pedido: mostrar como a transferência do SKU de depuração foi enviada, sem executar API.
- Explorer confirmou dois POSTs sequenciais: saída da master com token/depósito da master e, apenas após sucesso, entrada na filial com token/depósito da filial.
- O log do usuário confirma saída da master aprovada e entrada da filial rejeitada com HTTP 400 `deposito.id` não encontrado; não existe compensação automática no código atual.

## 2026-09-22 — Correlação de produtos entre empresas

- O usuário solicitou esclarecer IDs distintos de produto. Fato confirmado: o script usa o SKU como chave e busca o ID interno individualmente em cada conta autenticada antes dos POSTs de estoque.

## 2026-09-22 — Diagnóstico solicitado para falhas de estoque

- Usuário pediu que erros futuros exibam variáveis usadas/origem, requisições e respostas.
- Contrato sanitizado definido: metadados e resumos de resposta, sem segredos ou respostas brutas potencialmente extensas.

## 2026-09-22 — Gate 3 reprovado / diagnóstico de transferência

- QA e revisão identificaram falhas: POST com falha era atribuído sempre à filial, o corpo era reconstruído sem timestamp e o GET diagnosticado podia divergir da URL efetiva.
- Estado: Loop Engineering ativo; não entregar a funcionalidade até o rastro identificar a empresa/etapa corretas, corpo efetivo e resposta resumida de cada GET.

## 2026-09-22 — Gate 3 reprovado novamente / retentativas e origem segura

- Revalidação confirmou melhorias, mas identificou inconsistência no campo externo de empresa e rastro incompleto em POST com retry.
- Também falta registrar o seletor seguro de fonte de token (`*_TOKEN_SOURCE`, `db`/`env`), sem token ou SQL.
- Estado: Loop Engineering permanece ativo até que o relatório e o trace por tentativa sejam consistentes.

## 2026-09-22 — Gates 4 e 5 / diagnóstico de transferência aprovado

- Implementador corrigiu empresa/etapa no relatório, incluiu fonte segura de token e rastreou cada tentativa POST com body e status efetivos.
- QA e revisão independentes aprovaram: consultas GET codificadas e resumidas, POSTs/retentativas exatos, dados sensíveis excluídos.
- Não houve API real nem mudança de ordem das movimentações; risco de transferência parcial continua como item separado.
