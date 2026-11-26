import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DASHBOARD_API_KEY'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Variáveis obrigatórias ausentes: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
app.use(helmet());
app.use((req, res, next) => {
  const origin = req.get('origin');
  const allowedOrigin = process.env.CORS_ORIGIN;
  if (allowedOrigin && origin === allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Meta exige validação HMAC sobre o corpo bruto. Por isso o webhook tem parser próprio.
app.get('/health', (_req, res) => res.json({ ok: true, service: 'sm-solution-math-api' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const graphVersion = process.env.META_GRAPH_VERSION || 'v27.0';
const graphBase = `https://graph.facebook.com/${graphVersion}`;
const cleanPhone = (value = '') => String(value).replace(/\D/g, '').slice(0, 15);
const safeText = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';

function requireApiKey(req, res, next) {
  const provided = req.get('x-api-key');
  if (!provided || provided !== process.env.DASHBOARD_API_KEY) return res.status(401).json({ error: 'Não autorizado.' });
  next();
}
function verifyMetaSignature(req) {
  const secret = process.env.META_APP_SECRET;
  const signature = req.get('x-hub-signature-256');
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function onceEvent(provider, eventKey, payload) {
  const { error } = await supabase.from('webhook_events').insert({ provider, event_key: eventKey, payload });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw error;
}
async function upsertContact({ name, phone, email, company }) {
  const normalized = cleanPhone(phone);
  if (!normalized) throw new Error('Contato sem telefone válido.');
  const row = { name: safeText(name, 120) || null, phone: normalized, email: safeText(email, 160) || null, company: safeText(company, 160) || null, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('contacts').upsert(row, { onConflict: 'phone' }).select().single();
  if (error) throw error;
  return data;
}
async function upsertLead({ contact, source, sourceDetail, externalLeadId, fields = {} }) {
  const row = {
    contact_id: contact.id,
    name: safeText(fields.name || contact.name, 120) || null,
    company: safeText(fields.company || contact.company, 160) || null,
    phone: contact.phone,
    email: safeText(fields.email || contact.email, 160) || null,
    city: safeText(fields.city, 100) || null,
    segment: safeText(fields.segment, 100) || null,
    source,
    source_detail: safeText(sourceDetail, 200) || null,
    external_lead_id: externalLeadId || null,
    updated_at: new Date().toISOString()
  };
  let query = supabase.from('leads');
  if (externalLeadId) query = query.upsert(row, { onConflict: 'external_lead_id' });
  else query = query.insert(row);
  const { data, error } = await query.select().single();
  if (error) throw error;
  return data;
}
async function getOrCreateConversation(contact, lead, channel = 'whatsapp') {
  const { data, error } = await supabase.from('conversations').upsert({
    contact_id: contact.id, lead_id: lead?.id || null, channel, status: 'open',
    last_message_at: new Date().toISOString(), updated_at: new Date().toISOString()
  }, { onConflict: 'contact_id,channel' }).select().single();
  if (error) throw error;
  return data;
}
async function sendWhatsAppTemplate(to, templateName = process.env.META_TEMPLATE_NAME) {
  const token = process.env.META_ACCESS_TOKEN;
  const phoneId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId || !templateName) throw new Error('Token, número e modelo aprovado da Meta precisam estar configurados.');
  const response = await fetch(`${graphBase}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: templateName, language: { code: process.env.META_TEMPLATE_LANGUAGE || 'pt_BR' } } })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Meta API ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
async function sendWhatsAppText(to, body) {
  const token = process.env.META_ACCESS_TOKEN;
  const phoneId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('Cloud API ainda não configurada.');
  const response = await fetch(`${graphBase}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Meta API ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
async function saveMessage(conversationId, { providerMessageId, direction, body, rawPayload, status = 'received' }) {
  const row = { conversation_id: conversationId, provider_message_id: providerMessageId || null, direction, body: safeText(body, 4000) || null, raw_payload: rawPayload || null, delivery_status: status };
  const { error } = await supabase.from('messages').insert(row);
  if (error && error.code !== '23505') throw error;
}

// WhatsApp webhook verification (GET)
app.get('/webhooks/whatsapp', (req, res) => {
  const valid = req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.META_VERIFY_TOKEN;
  if (!valid) return res.sendStatus(403);
  return res.status(200).send(req.query['hub.challenge']);
});

// WhatsApp inbound events (POST)
app.post('/webhooks/whatsapp', express.raw({ type: 'application/json', limit: '2mb' }), async (req, res) => {
  try {
    if (!verifyMetaSignature(req)) return res.sendStatus(401);
    const payload = JSON.parse(req.body.toString('utf8'));
    res.sendStatus(200); // Confirma rapidamente; processamento ocorre após aceitar o evento.
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        for (const message of change.value?.messages || []) {
          const id = message.id;
          if (!id || !(await onceEvent('whatsapp', id, payload))) continue;
          const from = cleanPhone(message.from);
          const text = message.text?.body || `[Mensagem do tipo ${message.type || 'desconhecido'}]`;
          const contact = await upsertContact({ name: change.value?.contacts?.[0]?.profile?.name, phone: from });
          let { data: existingLead } = await supabase.from('leads').select('*').eq('phone', from).order('created_at', { ascending: false }).limit(1).maybeSingle();
          const lead = existingLead || await upsertLead({ contact, source: 'whatsapp', sourceDetail: 'Mensagem recebida' });
          const conversation = await getOrCreateConversation(contact, lead, 'whatsapp');
          await saveMessage(conversation.id, { providerMessageId: id, direction: 'inbound', body: text, rawPayload: message });
          await supabase.from('leads').update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', lead.id);

          // A resposta automática só roda quando habilitada. O cliente acabou de iniciar a conversa,
          // portanto a resposta está dentro da janela de atendimento iniciada pela mensagem recebida.
          if (process.env.AUTO_REPLY_ENABLED === 'true' && message.type === 'text') {
            const reply = process.env.AUTO_REPLY_TEXT;
            const sent = await sendWhatsAppText(from, reply);
            await saveMessage(conversation.id, { providerMessageId: sent.messages?.[0]?.id, direction: 'outbound', body: reply, rawPayload: sent, status: 'sent' });
          }
        }
      }
    }
  } catch (error) {
    console.error('Erro no webhook WhatsApp:', error);
    if (!res.headersSent) res.sendStatus(500);
  }
});

// Meta Lead Ads webhook verification
app.get('/webhooks/meta-leads', (req, res) => {
  const valid = req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.META_VERIFY_TOKEN;
  if (!valid) return res.sendStatus(403);
  return res.status(200).send(req.query['hub.challenge']);
});

// Meta Lead Ads webhook: notification contains leadgen_id; backend fetches actual form data.
app.post('/webhooks/meta-leads', express.raw({ type: 'application/json', limit: '2mb' }), async (req, res) => {
  try {
    if (!verifyMetaSignature(req)) return res.sendStatus(401);
    const payload = JSON.parse(req.body.toString('utf8'));
    res.sendStatus(200);
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'leadgen') continue;
        const leadgenId = String(change.value?.leadgen_id || '');
        if (!leadgenId || !(await onceEvent('meta-leads', leadgenId, payload))) continue;
        const token = process.env.META_PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;
        if (!token) throw new Error('META_PAGE_ACCESS_TOKEN não configurado.');
        const url = new URL(`${graphBase}/${leadgenId}`);
        url.searchParams.set('access_token', token);
        url.searchParams.set('fields', 'id,created_time,field_data,form_id,ad_id,campaign_id');
        const response = await fetch(url);
        const data = await response.json();
        if (!response.ok) throw new Error(`Falha ao buscar lead Meta: ${JSON.stringify(data)}`);
        const fields = Object.fromEntries((data.field_data || []).map((f) => [f.name, f.values?.[0] || '']));
        const phone = cleanPhone(fields.phone_number || fields.phone || fields.whatsapp_number);
        const consentValue = String(fields.whatsapp_opt_in || fields.whatsapp_consent || '').trim().toLowerCase();
        const hasWhatsAppConsent = ['yes', 'sim', 'true', '1', 'aceito', 'concordo'].includes(consentValue);
        if (!phone) { console.warn(`Lead Meta ${leadgenId} sem telefone; revisar formulário/cadastro.`); continue; }
        const contact = await upsertContact({ name: fields.full_name || [fields.first_name, fields.last_name].filter(Boolean).join(' '), phone, email: fields.email, company: fields.company_name });
        const savedLead = await upsertLead({ contact, source: 'meta_ads', sourceDetail: `form:${data.form_id || ''};ad:${data.ad_id || ''}`, externalLeadId: leadgenId, fields: { name: fields.full_name, company: fields.company_name, email: fields.email, city: fields.city } });
        if (hasWhatsAppConsent) {
          await supabase.from('leads').update({ whatsapp_opt_in: true, whatsapp_opt_in_at: new Date().toISOString() }).eq('id', savedLead.id);
          if (process.env.META_TEMPLATE_NAME) {
            const sent = await sendWhatsAppTemplate(phone);
            const conversation = await getOrCreateConversation(contact, savedLead, 'whatsapp');
            await saveMessage(conversation.id, { providerMessageId: sent.messages?.[0]?.id, direction: 'outbound', body: `[Modelo aprovado: ${process.env.META_TEMPLATE_NAME}]`, rawPayload: sent, status: 'sent' });
          }
        }
      }
    }
  } catch (error) {
    console.error('Erro no webhook Meta Lead Ads:', error);
    if (!res.headersSent) res.sendStatus(500);
  }
});

app.use(express.json({ limit: '1mb' }));
app.post('/api/leads', requireApiKey, async (req, res) => {
  const schema = z.object({ name: z.string().min(1).max(120), phone: z.string().min(8).max(25), email: z.string().email().optional().or(z.literal('')), company: z.string().max(160).optional(), city: z.string().max(100).optional(), segment: z.string().max(100).optional(), source: z.enum(['site','instagram','facebook','manual']).default('site'), whatsapp_opt_in: z.boolean().default(false) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos.', details: parsed.error.flatten() });
  try {
    const value = parsed.data;
    const contact = await upsertContact(value);
    const lead = await upsertLead({ contact, source: value.source, sourceDetail: 'Formulário do site', fields: value });
    if (value.whatsapp_opt_in) {
      await supabase.from('leads').update({ whatsapp_opt_in: true, whatsapp_opt_in_at: new Date().toISOString() }).eq('id', lead.id);
      if (process.env.META_TEMPLATE_NAME) {
        const sent = await sendWhatsAppTemplate(contact.phone);
        const conversation = await getOrCreateConversation(contact, lead, 'whatsapp');
        await saveMessage(conversation.id, { providerMessageId: sent.messages?.[0]?.id, direction: 'outbound', body: `[Modelo aprovado: ${process.env.META_TEMPLATE_NAME}]`, rawPayload: sent, status: 'sent' });
      }
    }
    res.status(201).json({ lead });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Não foi possível cadastrar o lead.' }); }
});

app.get('/api/leads', requireApiKey, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const { data, error } = await supabase.from('leads').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: 'Falha ao consultar leads.' });
  res.json({ leads: data });
});

app.get('/api/conversations', requireApiKey, async (_req, res) => {
  const { data, error } = await supabase.from('conversations').select('*, contacts(name,phone), leads(source,status)').order('last_message_at', { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: 'Falha ao consultar conversas.' });
  res.json({ conversations: data });
});

app.get('/api/conversations/:id/messages', requireApiKey, async (req, res) => {
  const { data, error } = await supabase.from('messages').select('*').eq('conversation_id', req.params.id).order('created_at', { ascending: true }).limit(500);
  if (error) return res.status(500).json({ error: 'Falha ao consultar mensagens.' });
  res.json({ messages: data });
});

app.post('/api/conversations/:id/messages', requireApiKey, async (req, res) => {
  const body = safeText(req.body?.text, 4000);
  if (!body) return res.status(400).json({ error: 'Texto da mensagem obrigatório.' });
  const { data: conversation, error } = await supabase.from('conversations').select('*, contacts(phone)').eq('id', req.params.id).single();
  if (error || !conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });
  try {
    const result = await sendWhatsAppText(conversation.contacts.phone, body);
    await saveMessage(conversation.id, { providerMessageId: result.messages?.[0]?.id, direction: 'outbound', body, rawPayload: result, status: 'sent' });
    res.status(201).json({ sent: true, result });
  } catch (err) { console.error(err); res.status(502).json({ error: 'Falha ao enviar pela API do WhatsApp.' }); }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`SM Solution Math API ouvindo na porta ${port}`));
