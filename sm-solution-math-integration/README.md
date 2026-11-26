# SM Solution Math — Integração CRM (fase inicial)

Backend inicial para centralizar leads e conversas no Supabase e receber eventos da Meta.

## O que já está preparado no código

- API Node.js/Express com endpoint de saúde.
- Conexão ao Supabase usando `SERVICE_ROLE_KEY` apenas no servidor.
- Schema PostgreSQL para contatos, leads, conversas, mensagens e eventos de webhook.
- Webhook WhatsApp com verificação de assinatura `X-Hub-Signature-256` e verificação inicial GET.
- Recebimento de mensagens e criação/associação de lead e conversa.
- Resposta automática textual opcional para mensagens recebidas, desativada por padrão (`AUTO_REPLY_ENABLED=false`).
- Envio opcional de modelo aprovado da Meta para leads de formulário, somente quando há opt-in explícito e `META_TEMPLATE_NAME` está configurado.
- Webhook Meta Lead Ads: recebe `leadgen_id` e busca os campos na Graph API.
- Endpoint para formulário do site e endpoints protegidos para listar leads/conversas e enviar mensagem manual.
- Deduplicação de eventos via `webhook_events` e IDs externos.

## O que ainda depende de configuração/credenciais

Este pacote **não está conectado às contas reais**. É necessário criar/configurar o projeto Supabase e o app Meta, preencher variáveis de ambiente, publicar o backend em HTTPS, configurar webhooks e realizar testes com a equipe. A integração do painel HTML existente também é uma próxima etapa: ele ainda usa `localStorage` e autenticação de demonstração, não consome estes endpoints.

## Requisitos

- Node.js 20 ou superior.
- Projeto Supabase.
- App Meta configurado para WhatsApp Business Platform e Webhooks.
- Domínio HTTPS para o backend.

## Instalação local

1. Copie `.env.example` para `.env`.
2. Preencha `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DASHBOARD_API_KEY` e, quando disponíveis, os dados Meta.
3. No Supabase SQL Editor, execute `sql/schema.sql`.
4. Instale e inicie:

```bash
npm install
npm run dev
```

5. Teste `GET /health`.

## Webhooks Meta

Configure no painel Meta:

- WhatsApp: callback `https://SEU-DOMINIO-API.com/webhooks/whatsapp`
- Lead Ads: callback `https://SEU-DOMINIO-API.com/webhooks/meta-leads`
- Token de verificação: mesmo valor de `META_VERIFY_TOKEN`.
- App Secret: `META_APP_SECRET`, usado para validar assinatura.

Para Lead Ads, assine o objeto Page e o campo `leadgen`, instale o app na Página e conceda as permissões necessárias. O evento contém um ID; o backend usa o token da Página para buscar os dados do formulário.

## Número atual do WhatsApp

Não remova nem migre o número do aplicativo WhatsApp Business antes de verificar a elegibilidade e o fluxo de coexistência oferecido pela Meta para a conta. A coexistência permite, em cenários elegíveis, usar o app e a plataforma; a disponibilidade e requisitos dependem da conta e do processo de onboarding. Se a conta não for elegível, a migração pode afetar o uso do app. Faça essa etapa com o administrador da conta comercial.

## Automação

A resposta automática está desligada por padrão. Para habilitar em ambiente de teste, defina `AUTO_REPLY_ENABLED=true`. O exemplo responde somente a mensagens de texto recebidas e usa uma mensagem fixa. Antes de produção, implementar regras de intenção, transferência humana, controle de janela de atendimento, opt-out e tratamento de mensagens fora da janela de 24 horas. Para leads de formulário, o envio inicial só ocorre com opt-in explícito e `META_TEMPLATE_NAME` configurado para um modelo aprovado pela Meta.

Não use a resposta fixa para campanhas em massa. Mensagens proativas precisam respeitar consentimento e políticas da Meta. Não envie mensagem automática para um lead de formulário apenas porque ele forneceu telefone: primeiro registre e valide autorização específica para contato via WhatsApp. O formulário deve incluir uma caixa de consentimento clara e não pré-marcada; para Meta Lead Ads, inclua campo equivalente e revise o nome/campo retornado pela Graph API.

## Segurança — antes de produção

- Não publique `.env`, tokens ou `SERVICE_ROLE_KEY` no GitHub ou frontend.
- Configure `CORS_ORIGIN` para o domínio exato do painel.
- Substitua a chave compartilhada `DASHBOARD_API_KEY` por autenticação individual via Supabase Auth/JWT e autorização por organização.
- Adicione `organization_id` às tabelas e políticas RLS por empresa antes de múltiplos clientes/organizações.
- Adicione rate limiting, logs estruturados, alertas, política de retenção e rotina de backup.
- Use HTTPS, segredos gerenciados pelo provedor e rotação de tokens.
- Faça revisão de LGPD, aviso de privacidade e processo para atender pedidos de acesso/exclusão.

## Endpoints iniciais

- `GET /health`
- `GET /webhooks/whatsapp`
- `POST /webhooks/whatsapp`
- `GET /webhooks/meta-leads`
- `POST /webhooks/meta-leads`
- `POST /api/leads` (x-api-key)
- `GET /api/leads` (x-api-key)
- `GET /api/conversations` (x-api-key)
- `GET /api/conversations/:id/messages` (x-api-key)
- `POST /api/conversations/:id/messages` (x-api-key)

## Próxima etapa de desenvolvimento

1. Subir backend e executar testes com payloads de teste Meta.
2. Configurar onboarding do número atual e confirmar coexistência.
3. Implementar autenticação Supabase no painel e substituir armazenamento local por API.
4. Criar interface de caixa de entrada e status de integrações.
5. Implementar Instagram Lead Ads e integração do formulário real do site, validando o formato dos campos usados.
6. Substituir a resposta fixa por fluxo de qualificação revisado pela empresa.
