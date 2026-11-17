# Decisões

## 2026-09-21 — Diagnóstico antes de alterar endpoint

- Estado: proposta em investigação.
- Contexto: navegador manual retorna quantidades, enquanto o fluxo automatizado teria retornado saldos zerados.
- Decisão: não trocar host, URL, depósito ou credenciais sem evidência de uma requisição automatizada sanitizada. A diferença provável é de sessão/tenant, mas ainda não está confirmada.

## 2026-09-21 — Contrato de reparo em aberto

- Estado: aguardando decisão do usuário.
- Fato: `main.ts` passa o ID da filial sem alteração ao downloader; a URL o codifica com `encodeURIComponent`.
- Fato: o downloader não afirma rota/tenant autenticado após o login e a validação de arquivo aceita XLS com todos os saldos zero.
- Proposta: diagnosticar contexto autenticado e metadados/estatísticas sanitizados; baixar no contexto do browser. A política para inventário realmente vazio exige decisão explícita, pois abortar todo XLS zerado pode bloquear um depósito legitimamente vazio.

## 2026-09-21 — Isolamento explícito de autenticação por filial

- Estado: aprovado pelo usuário, em implementação.
- Decisão: para cada tentativa de download, criar um contexto de browser isolado e limpar cookies, cache e armazenamento dos domínios Tiny/Olist antes do login; encerrar o browser e limpar novamente ao fim.
- Impacto: não resolve sozinho uma possível permissão/tenant incorreto, mas elimina reuso local de estado de autenticação entre empresas.

## 2026-09-21 — Inventário válido com saldo todo zero

- Estado: aprovado pelo usuário, em implementação.
- Decisão: não tratar saldo totalmente zerado como falha de download nem bloquear transferências automaticamente; registrar aviso claro e profissional para revisão operacional, pois o cenário é raro mas possível.

## 2026-09-22 — Diagnóstico de falhas de transferência

- Estado: aprovado pelo usuário, em planejamento.
- Decisão: em falha, expor apenas contexto operacional sanitizado: SKU, empresa lógica, origem dos IDs de produto/deposito, método/URL sem credenciais, body sem segredos e resumo de respostas. Não registrar cabeçalhos de autorização, cookies, senhas nem payloads completos de busca de produto.
