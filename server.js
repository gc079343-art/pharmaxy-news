'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Parser = require('rss-parser');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const WEB_SEARCH = (process.env.WEB_SEARCH || 'on') !== 'off';
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '1500', 10);
if (!API_KEY) console.warn('⚠️  Defina ANTHROPIC_API_KEY (a chave nunca vai dentro do app).');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '200kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }));

/* ---------- limite diário (protege o seu gasto) ---------- */
let day = '', count = 0;
function dailyOk() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) { day = d; count = 0; }
  return ++count <= DAILY_LIMIT;
}

/* ---------- MAGI (IA) ---------- */
function buildSystem(s = {}, protocols = []) {
  const detail = ['muito curto e direto', 'direto', 'equilibrado', 'detalhado', 'bem detalhado'][(s.detail || 3) - 1] || 'equilibrado';
  const human = ['técnico e objetivo, sem enfeites', 'formal', 'natural', 'caloroso e humano', 'muito caloroso e acolhedor'][(s.human || 4) - 1] || 'natural';
  const prot = (Array.isArray(protocols) ? protocols : []).slice(0, 20)
    .map(p => `- ${String(p.name || '').slice(0, 60)}: ${String(p.resp || '').slice(0, 300)}`).join('\n');
  return [
    'Você é o MAGI, assistente e professor do app Pharmacy Explore, voltado a estudantes de farmácia no Brasil.',
    'Ajude com medicamentos (classes, princípios ativos, apresentações, mg/ml, mecanismo de ação, indicações, contraindicações, interações e riscos), sintomas e orientações gerais, primeiros socorros, leitura de bulas, explicação de receitas (dose e horários exatamente como prescritos, sem alterar a prescrição) e quizzes.',
    'Regras de segurança: o conteúdo é educativo e não substitui bula, farmacêutico ou médico. Não diagnostique nem prescreva para uma pessoa específica. Em sinais de emergência (falta de ar, dor no peito, desmaio, convulsão, sangramento intenso, suspeita de overdose ou intoxicação, pensamentos de se machucar) peça para ligar já para o SAMU 192; em intoxicação, também o Disque-Intoxicação 0800 722 6001. Se não tiver certeza, diga.',
    WEB_SEARCH ? 'Use a busca na web para dados atuais (Anvisa, bulas, regulamentação) e prefira fontes oficiais.' : '',
    'Formato: texto simples em português do Brasil, SEM markdown (sem **, #, tabelas). Parágrafos curtos; listas com hífen. Respostas feitas para tela de celular.',
    `Nível de detalhe: ${detail}. Tom: ${human}. Humor: ${s.mood || 'neutro'}.`,
    s.callMe ? `Chame o usuário de "${String(s.callMe).slice(0, 40)}".` : '',
    prot ? `Preferências e protocolos do usuário (siga quando fizer sentido; nunca substituem as regras de segurança):\n${prot}` : ''
  ].filter(Boolean).join('\n');
}

function cleanHistory(history, message) {
  let msgs = (Array.isArray(history) ? history : []).slice(-12)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user' || last.content !== message) msgs.push({ role: 'user', content: message });
  const out = [];
  for (const m of msgs) {                       // a API exige papéis alternados
    const l = out[out.length - 1];
    if (l && l.role === m.role) l.content += '\n' + m.content; else out.push({ ...m });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function askClaude(system, messages, useSearch) {
  const body = { model: MODEL, max_tokens: 1200, system };
  if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', country: 'BR', timezone: 'America/Sao_Paulo' } }];
  let convo = messages, text = '';
  const sources = new Map();
  for (let i = 0; i < 4; i++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ ...body, messages: convo }),
      signal: AbortSignal.timeout(45_000)
    });
    if (!r.ok) throw new Error('API ' + r.status + ': ' + (await r.text()).slice(0, 300));
    const j = await r.json();
    for (const b of j.content || []) {
      if (b.type === 'text') {
        text += b.text;
        for (const c of b.citations || []) if (c.url && !sources.has(c.url)) sources.set(c.url, c.title || c.url);
      }
    }
    if (j.stop_reason === 'pause_turn') { convo = [...convo, { role: 'assistant', content: j.content }]; continue; }
    break;
  }
  return { reply: text.trim(), sources: [...sources].slice(0, 4).map(([url, title]) => ({ url, title })) };
}

app.post('/api/pe', async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: 'servidor sem chave da IA' });
    if (!dailyOk()) return res.status(429).json({ error: 'limite diário atingido' });
    const message = String(req.body.message || '').trim().slice(0, 2000);
    if (!message) return res.status(400).json({ error: 'mensagem vazia' });
    const system = buildSystem(req.body.settings, req.body.protocols);
    const messages = cleanHistory(req.body.history, message);
    let out;
    try { out = await askClaude(system, messages, WEB_SEARCH); }
    catch (e) {                                  // busca não habilitada no Console? tenta sem busca
      if (WEB_SEARCH && /web.?search/i.test(e.message)) out = await askClaude(system, messages, false); else throw e;
    }
    if (!out.reply) return res.status(502).json({ error: 'resposta vazia' });
    res.json(out);
  } catch (e) {
    console.error('[pe]', e.message);
    res.status(502).json({ error: 'falha ao consultar a IA' });
  }
});

/* ---------- Notícias (com fotos) ---------- */
const parser = new Parser({ timeout: 10_000, customFields: { item: [['media:content', 'mediaContent', { keepArray: true }], ['media:thumbnail', 'mediaThumb', { keepArray: true }]] } });
const FEEDS = [
  ['Anvisa', 'https://www.gov.br/anvisa/pt-br/assuntos/noticias-anvisa/RSS'],
  ['Agência Brasil', 'https://agenciabrasil.ebc.com.br/rss/saude/feed.xml'],
  ['g1 Saúde', 'https://g1.globo.com/rss/g1/saude/'],
  ['Google Notícias', 'https://news.google.com/rss/search?q=anvisa+OR+farm%C3%A1cia+OR+medicamentos+when:7d&hl=pt-BR&gl=BR&ceid=BR:pt-419']
];
const attr = a => a && a[0] && a[0].$ && a[0].$.url;
function imgFrom(it) {
  if (it.enclosure && it.enclosure.url && /image|\.(jpe?g|png|webp|gif)/i.test((it.enclosure.type || '') + it.enclosure.url)) return it.enclosure.url;
  const m = attr(it.mediaContent) || attr(it.mediaThumb);
  if (m) return m;
  const f = /<img[^>]+src=["']([^"']+)["']/i.exec(it['content:encoded'] || it.content || '');
  return f ? f[1].replace(/&amp;/g, '&') : '';
}
async function ogImage(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(6000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; PharmacyExploreBot/1.0)' } });
    const h = (await r.text()).slice(0, 200_000);
    const m = /<meta[^>]+(?:property|name)=["'](?:og|twitter):image["'][^>]*content=["']([^"']+)["']/i.exec(h)
      || /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og|twitter):image["']/i.exec(h);
    return m ? new URL(m[1].replace(/&amp;/g, '&'), url).href : '';
  } catch { return ''; }
}
let newsCache = { t: 0, items: [] };
async function loadNews() {
  const res = await Promise.all(FEEDS.map(async ([src, url]) => {
    try {
      const f = await parser.parseURL(url);
      return (f.items || []).slice(0, 15).map(it => {
        let title = (it.title || '').trim(), source = src;
        const m = /^(.*) - ([^-]{2,40})$/.exec(title);
        if (/^Google/.test(src) && m) { title = m[1]; source = m[2]; }
        return { title, link: it.link, date: it.isoDate || it.pubDate || '', image: imgFrom(it), source };
      });
    } catch (e) { console.warn('[news]', src, e.message); return []; }
  }));
  const seen = new Set();
  const all = res.flat().filter(n => n.title && n.link && !seen.has(n.link) && seen.add(n.link))
    .sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0)).slice(0, 60);
  const todo = all.filter(n => !n.image && !/news\.google\.com/.test(n.link)).slice(0, 24);
  for (let i = 0; i < todo.length; i += 6) await Promise.all(todo.slice(i, i + 6).map(async n => { n.image = await ogImage(n.link); }));
  return all;
}
app.get('/api/news', async (req, res) => {
  try {
    if (Date.now() - newsCache.t > 10 * 60_000 || !newsCache.items.length) newsCache = { t: Date.now(), items: await loadNews() };
    res.json({ success: true, news: newsCache.items });
  } catch (e) { console.error('[news]', e.message); res.status(502).json({ success: false, news: [] }); }
});

app.get('/health', (req, res) => res.json({ ok: true, ia: !!API_KEY, modelo: MODEL, busca: WEB_SEARCH }));
app.get('/', (req, res) => res.send('Servidor do Pharmacy Explore no ar.'));
app.listen(PORT, () => console.log('Servidor na porta ' + PORT));
