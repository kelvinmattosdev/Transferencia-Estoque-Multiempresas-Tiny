# Contexto do projeto

- Script TypeScript/Node para transferir estoque entre uma empresa master e filiais via Tiny/Olist.
- Baixa inventários de filiais por automação Puppeteer e requisição HTTPS; processa-os com `xlsx`; então envia movimentações via API.
- O endpoint de inventário é montado em `src/services/tinyPuppeteer.service.ts`. A sessão do download vem do login automatizado, não do token da API.
- Para transferências, o SKU da planilha é a chave de correlação. O script consulta `GET /produtos?codigo=<SKU>&situacao=A` separadamente com o token de cada empresa e usa o primeiro `itens[0].id` retornado como ID interno no respectivo `POST /estoque/{id}`.
