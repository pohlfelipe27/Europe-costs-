# Europe Costs

Controle de gastos de viagem, com acesso restrito a você e à família.
Você lança cada gasto e vê indicadores, gráficos e tabelas. O visual é em preto e azul.

- **Lançamento manual:** data, descrição, categoria, valor, forma de pagamento e observação. Dá para editar e excluir.
- **Indicadores:** total gasto (também em R$), orçamento restante, média por dia, projeção para a viagem, maior gasto e ticket médio.
- **Gráficos:** gasto por categoria, gasto por dia (empilhado por categoria, com a linha do orçamento diário), acumulado vs. orçamento e gasto por forma de pagamento.
- **Tabelas:** resumo por categoria e lista completa com busca, filtro por categoria e por dia, e **exportação para CSV** (abre no Excel).
- **Várias viagens:** já está pronto para crescer. Hoje você cria uma viagem de 10 dias e, depois, pode criar outras.
- **Tempo real:** quando um familiar lança um gasto, ele aparece para todos (no modo nuvem).

É um site estático (HTML, CSS e JS, sem build). O banco de dados é o **Supabase**, que tem plano gratuito.

## Modos de funcionamento

| Modo | Quando | Onde ficam os dados |
|---|---|---|
| **Local** | `js/config.js` vazio (padrão) | Só no navegador em uso. Não sincroniza e some se você limpar os dados do navegador. |
| **Nuvem** | `js/config.js` preenchido | No Supabase, com login e compartilhamento entre a família. |

## Passo a passo para salvar na nuvem

### 1. Criar o projeto no Supabase
1. Crie uma conta em https://supabase.com e clique em **New project**. O plano Free basta.
2. Escolha uma região próxima, por exemplo São Paulo, e uma senha para o banco.

### 2. Criar as tabelas
1. No projeto, abra **SQL Editor → New query**.
2. Em `supabase/schema.sql`, **troque/adicione os e-mails da família** na parte `insert into public.allowed_users`.
3. Cole o arquivo inteiro e clique em **Run**.

Para adicionar alguém depois, rode:
```sql
insert into public.allowed_users (email) values ('fulano@email.com');
```

### 3. Criar os logins
1. Em **Authentication → Sign In / Providers**, desative **"Allow new users to sign up"**. Assim ninguém cria conta sozinho.
2. Em **Authentication → Users → Add user → Create new user**, crie um usuário com e-mail e senha para cada pessoa. Marque "Auto confirm user".

Mesmo que alguém consiga criar uma conta, só os e-mails da tabela `allowed_users` conseguem ler ou gravar dados.

### 4. Conectar o site ao banco
1. Em **Project Settings → API** (ou **Data API**), copie a **Project URL** e a chave **anon / public**.
2. Cole as duas em `js/config.js`:
   ```js
   window.APP_CONFIG = {
     SUPABASE_URL: "https://xxxx.supabase.co",
     SUPABASE_ANON_KEY: "eyJhbGciOi...",
   };
   ```
   A chave *anon* foi feita para ficar no navegador. Quem protege os dados são as regras de segurança (RLS) do passo 2.
   **Nunca** coloque aqui a chave `service_role`.

### 5. Publicar o site (GitHub Pages)
1. Faça commit do `config.js` na branch principal.
2. No GitHub, abra o repositório e vá em **Settings → Pages**. Em *Source*, escolha **Deploy from a branch**, depois a branch `main` e a pasta `/ (root)`.
3. Em alguns minutos o site fica disponível em `https://<seu-usuario>.github.io/<repositório>/`.
4. No Supabase, em **Authentication → URL Configuration**, coloque esse endereço em *Site URL*.

> GitHub Pages gratuito exige repositório **público**. Isso não expõe seus gastos, porque os dados ficam no Supabase, protegidos por login. Se preferir o repositório privado, use Netlify ou Vercel (ambos gratuitos): é só importar o repositório, sem configuração de build.

No celular, abra o site e use "Adicionar à tela inicial". Ele passa a funcionar como um app.

## Rodar localmente
```bash
python3 -m http.server 8000
# abra http://localhost:8000
```

## Estrutura
```
index.html           página
css/style.css        visual (preto e azul)
js/config.js         chaves do Supabase (preencher)
js/store.js          salvar e ler dados (Supabase ou navegador)
js/app.js            telas, indicadores, gráficos e tabelas
supabase/schema.sql  tabelas e regras de segurança
```
