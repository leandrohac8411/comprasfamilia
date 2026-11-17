# Compras da família

Lista de compras compartilhada (casal), com login por e-mail/senha e dados salvos no Firebase Firestore.

- Os dois veem e editam a mesma lista em tempo real.
- Funciona offline no mercado: as alterações são enviadas quando a internet voltar.
- **Finalizar compra** salva o carrinho no histórico (data, mercado, quem comprou, itens e valores) e guarda o último preço de cada produto para comparar na próxima vez.
- O histórico mostra o total deste mês e do mês passado.

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | Telas e estilos |
| `app.js` | Lógica, login e Firestore |
| `firebase-config.js` | Configuração do Firebase e lista de usuários |
| `firestore.rules` | Regras de segurança (quem pode ler e gravar) |

## Configurar o Firebase

1. Crie um projeto em <https://console.firebase.google.com>.
2. **Authentication → Método de login →** ative **E-mail/senha**.
3. **Authentication → Usuários → Adicionar usuário:** crie um para você e um para sua esposa.
4. **Authentication → Configurações → Ações do usuário:** desmarque **Ativar criação (inscrição)**, para ninguém criar conta sozinho.
5. **Firestore Database → Criar banco de dados** (modo produção, região `southamerica-east1`).
6. **Firestore → Regras:** cole o conteúdo de `firestore.rules` com os dois e-mails e publique.
7. **Configurações do projeto → Seus apps → Web (`</>`):** registre o app e copie o `firebaseConfig` para `firebase-config.js`. Coloque os dois e-mails em `USERS`.

## Publicar no GitHub Pages

1. Suba o repositório no GitHub.
2. **Settings → Pages →** Branch `main`, pasta `/ (root)`.
3. No Firebase: **Authentication → Configurações → Domínios autorizados →** adicione `SEU-USUARIO.github.io`.

## Testar localmente

O app usa módulos JavaScript, então precisa de um servidor (não abre com duplo clique):

```bash
python -m http.server 8080
```

Depois abra <http://localhost:8080>.
