# Riscos e questões abertas

| Item | Impacto | Estado / decisão necessária |
| --- | --- | --- |
| A sessão do browser manual pode pertencer a outro tenant/perfil que a sessão automatizada | Alto: inventário pode diferir mesmo com o mesmo depósito na URL | Requer evidência sanitizada de identidade/tenant e metadados da resposta automatizada |
| Tiny pode redirecionar para Olist por HTML/JavaScript | Alto: cliente HTTPS não executa JavaScript | Confirmar endpoint e domínio autenticado atuais antes de trocar código |
| Arquivo local SC está vazio | Alto: não permite comparar cabeçalhos, linhas e saldos | Reproduzir download em modo diagnóstico sem movimentação |
| Política para planilha estruturalmente válida e toda zerada | Médio: pode indicar sessão/tenant incorreto, mas também representa depósito legitimamente vazio | Decidido: alertar, sem bloquear automaticamente |
| Transferência parcial entre empresas | Crítico: lançamento de saída é enviado antes do lançamento de entrada; a entrada pode falhar após a saída confirmada | Confirmado pelo log de 2026-09-22; requer decisão/implementação de compensação antes de nova execução produtiva |
| Token lógico da SC pode pertencer a outra empresa | Alto: Tiny responde `deposito.id` não encontrado embora o ID seja enviado | Conferir a origem do token no banco sem expor token; a query fornecida pelo usuário referencia `jaufishing` para a configuração SC |
