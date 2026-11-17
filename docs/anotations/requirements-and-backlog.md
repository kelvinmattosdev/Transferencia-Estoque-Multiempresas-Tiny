# Requisitos e backlog

## Em investigação

- Confirmar por que o download automatizado do inventário de uma filial pode divergir da mesma URL aberta manualmente.
- Preservar bloqueio de transferências enquanto o inventário não tiver saldo confiável.
- Pendente de decisão: inventário com todas as quantidades zero deve apenas alertar ou sempre abortar para esta filial?
- Corrigir o risco de transferência parcial: a saída pode ser confirmada antes de a entrada falhar; origem: log do usuário em 2026-09-22.
- Concluído: em erros de transferência, registrar diagnóstico sanitizado por SKU: origem dos IDs, requisições realizadas e respostas resumidas, sem tokens/cookies/senhas; origem: solicitação do usuário em 2026-09-22.

## Concluído

- Garantir uma sessão de browser isolada e sem dados de autenticação persistidos para cada login/download de filial, por solicitação do usuário em 2026-09-21.
- Quando um inventário válido tiver todos os saldos zerados, não bloquear o job; emitir alerta profissional nos logs sobre possível inconsistência, por solicitação do usuário em 2026-09-21.

## Concluído anteriormente

- Validação e retentativas de download de planilhas.
- `DEBUG_SKU` para limitar movimentações a SKUs explicitamente configurados.
