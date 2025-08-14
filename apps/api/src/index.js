const path = require('path');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Load tokens from env or fallback to docs (for local demo only)
const TOKENS = {
  ITP: process.env.ITP_TOKEN || '91b2c57abce2ca84f8ca068df2eda054',
  DYXLESS: process.env.DYXLESS_TOKEN || '38a634df-2317-4c8c-beb7-7ca4fd97f1e1',
  LEAKOSINT: process.env.LEAKOSINT_TOKEN || '466496291:r571DgY3',
  USERSBOX: process.env.USERSBOX_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjcmVhdGVkX2F0IjoxNzUyNTg0NTk5LCJhcHBfaWQiOjE3NTI1ODQ1OTl9.FqMGisO5V1xW2Xr8Ri5mQryy5I1sdBBWzuckCEPpK58',
  VEKTOR: process.env.VEKTOR_TOKEN || 'C45vAVuDkzNax2BF4sz8o4KEAZFBIIK'
};

const ITP_BASE = process.env.ITP_BASE || 'https://datatech.work';
const DYXLESS_BASE = process.env.DYXLESS_BASE || 'https://api-dyxless.cfd';
const LEAKOSINT_BASE = 'https://leakosintapi.com/';
const USERSBOX_BASE = 'https://api.usersbox.ru/v1';
const VEKTOR_BASE = 'https://infosearch54321.xyz';

// OpenAI client
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
let openai = null;

// Initialize OpenAI client only if API key is available
console.log('Checking OpenAI API key...');
console.log('OPENAI_API_KEY exists:', !!OPENAI_API_KEY);
console.log('OPENAI_API_KEY length:', OPENAI_API_KEY ? OPENAI_API_KEY.length : 0);

if (OPENAI_API_KEY && OPENAI_API_KEY.trim() !== '') {
  try {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    console.log('✅ OpenAI client initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize OpenAI client:', error.message);
    openai = null;
  }
} else {
  console.warn('⚠️ OpenAI API key not found in environment variables');
  console.log('Available env vars:', Object.keys(process.env).filter(key => key.includes('OPENAI')));
}

// Company check providers
const DATANEWTON_BASE = process.env.DATANEWTON_BASE || 'https://api.datanewton.ru/v1';
const DATANEWTON_KEY = process.env.DATANEWTON_KEY || 'UeHgYI7e4ejX';
const CHECKO_BASE = process.env.CHECKO_BASE || 'https://api.checko.ru/v2';
const CHECKO_KEY = process.env.CHECKO_KEY || process.env.CHECKO_API_KEY || 'iWq90n732rGN2rex';

function extractUsernameIfSocial(field, query) {
  if (!query || (field !== 'vk' && field !== 'ok')) return query;
  try {
    // If it's a URL, parse and extract last meaningful segment
    if (/^https?:\/\//i.test(query)) {
      const u = new URL(query);
      const host = u.hostname.replace(/^www\./, '');
      if (host.includes('vk.com')) {
        // vk.com/id123 | vk.com/username | vk.com/club123 | vk.com/public123
        const seg = u.pathname.split('/').filter(Boolean);
        if (seg.length > 0) return seg[seg.length - 1];
      }
      if (host.includes('ok.ru') || host.includes('odnoklassniki.ru')) {
        // ok.ru/profile/123 | ok.ru/username
        const seg = u.pathname.split('/').filter(Boolean);
        if (seg.length > 0) return seg[seg.length - 1];
      }
    }
    // Otherwise return as-is (might be id12345 or username)
    return query.replace(/^@+/, '');
  } catch {
    return query;
  }
}

async function searchITP(query, field) {
  try {
    const itpTypeMap = {
      phone: 'phone',
      email: 'email',
      inn: 'inn',
      snils: 'snils',
      vk: 'username',
      ok: 'username'
    };
    const isSocial = field === 'vk' || field === 'ok';
    const adjustedQuery = isSocial ? extractUsernameIfSocial(field, query) : query;
    const itpType = itpTypeMap[field] || 'full_text';
    const res = await axios.post(
      ITP_BASE + '/public-api/data/search',
      {
        searchOptions: [
          { type: itpType, query: adjustedQuery }
        ]
      },
      { headers: { 'x-api-key': TOKENS.ITP } }
    );
    const data = res.data || {};
    return { name: 'ITP', ok: true, meta: { records: data.records, searchId: data.searchId }, items: data.data };
  } catch (err) {
    return { name: 'ITP', ok: false, error: normalizeError(err) };
  }
}

async function searchDyxless(query) {
  const attempt = async () => {
    const res = await axios.post(
      DYXLESS_BASE + '/query',
      { query, token: TOKENS.DYXLESS },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DataTrace/1.0'
        },
        timeout: 15000
      }
    );
    // If Cloudflare returns an HTML error page, treat as outage
    const ct = res.headers && res.headers['content-type'];
    if (ct && ct.includes('text/html') && typeof res.data === 'string') {
      throw { response: { status: res.status || 521, data: 'Cloudflare HTML error page' } };
    }
    const data = res.data || {};
    return { name: 'Dyxless', ok: !!data.status, meta: { count: data.counts }, items: data.data };
  };

  try {
    return await attempt();
  } catch (e1) {
    // quick retry on 52x / network errors
    await new Promise((r) => setTimeout(r, 600));
    try {
      return await attempt();
    } catch (e2) {
      return { name: 'Dyxless', ok: false, error: normalizeError(e2) };
    }
  }
}

async function searchLeakOsint(query) {
  try {
    const res = await axios.post(
      LEAKOSINT_BASE,
      { token: TOKENS.LEAKOSINT, request: query, limit: 100, lang: 'ru', type: 'json' },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const data = res.data || {};
    // Error path
    if (data && (data['Error code'] || data.Error || data.error)) {
      return { name: 'LeakOsint', ok: false, error: data };
    }
    // Normal path
    const list = data.List || {};
    const items = Object.keys(list).map((k) => ({ db: k, info: list[k]?.InfoLeak, data: list[k]?.Data }));
    if (!Object.keys(list).length) {
      return { name: 'LeakOsint', ok: false, error: { message: 'Нет данных или неизвестный формат ответа', preview: data } };
    }
    return { name: 'LeakOsint', ok: true, items };
  } catch (err) {
    return { name: 'LeakOsint', ok: false, error: normalizeError(err) };
  }
}

async function searchUsersbox(query) {
  try {
    const res = await axios.get(
      USERSBOX_BASE + '/explain',
      {
        params: { q: query },
        headers: { Authorization: TOKENS.USERSBOX }
      }
    );
    const data = res.data || {};
    return { name: 'Usersbox', ok: data.status === 'success', items: data.data?.items, meta: { count: data.data?.count } };
  } catch (err) {
    return { name: 'Usersbox', ok: false, error: normalizeError(err) };
  }
}

async function searchVektor(query) {
  try {
    const url = `${VEKTOR_BASE}/api/${encodeURIComponent(TOKENS.VEKTOR)}/search/${encodeURIComponent(query)}`;
    const res = await axios.get(url);
    const data = res.data || {};
    if (data && data.error) {
      return { name: 'Vektor', ok: false, error: data.error };
    }
    if (!data || !data.result) {
      return { name: 'Vektor', ok: false, error: { message: 'Пустой ответ или нет поля result', preview: data } };
    }
    return { name: 'Vektor', ok: true, items: data.result };
  } catch (err) {
    return { name: 'Vektor', ok: false, error: normalizeError(err) };
  }
}

function normalizeError(err) {
  if (err.response) {
    const status = err.response.status;
    const statusText = err.response.statusText;
    const data = err.response.data;
    const isString = typeof data === 'string';
    return {
      status,
      statusText,
      preview: isString ? String(data).slice(0, 600) : undefined,
      data: !isString ? data : undefined,
    };
  }
  if (err.request) {
    return { message: 'No response from server', code: err.code };
  }
  return { message: err.message, code: err.code };
}

// Sequential search
app.post('/api/search', async (req, res) => {
  try {
    const { query, field } = req.body || {};
    if (!query || typeof query !== 'string' || query.trim().length < 3) {
      return res.status(400).json({ error: 'Введите корректный запрос (мин. 3 символа)' });
    }
    const allowedFields = new Set(['phone', 'email', 'vk', 'ok', 'inn', 'snils']);
    const f = allowedFields.has(field) ? field : 'full_text';

    const steps = [];
    // For social types, extract simplified username once
    const finalQuery = extractUsernameIfSocial(f, query);
    for (const [idx, fn] of [searchITP, searchDyxless, searchLeakOsint, searchUsersbox, searchVektor].entries()) {
      // eslint-disable-next-line no-await-in-loop
      const result = idx === 0 ? await fn(finalQuery, f) : await fn(finalQuery);
      steps.push(result);
    }

    res.json({ query: finalQuery, field: f, results: steps });
  } catch (e) {
    res.status(500).json({ error: normalizeError(e) });
  }
});

// Company search endpoints
async function searchDatanewton(inn) {
  try {
    const res = await axios.get(`${DATANEWTON_BASE}/counterparty`, {
      params: {
        key: DATANEWTON_KEY,
        inn,
        // include useful blocks by default
        filters: 'ADDRESS_BLOCK,OWNER_BLOCK,MANAGER_BLOCK,OKVED_BLOCK,CONTACT_BLOCK,NEGATIVE_LISTS_BLOCK'
      },
      timeout: 15000
    });
    console.log('Datanewton response:', JSON.stringify(res.data, null, 2));
    return { name: 'Datanewton', ok: true, items: res.data };
  } catch (err) {
    console.error('Datanewton error:', err.response?.data || err.message);
    return { name: 'Datanewton', ok: false, error: normalizeError(err) };
  }
}

async function searchChecko(inn) {
  if (!CHECKO_KEY || CHECKO_KEY.trim() === '') {
    return { name: 'Checko', ok: false, error: { message: 'Отсутствует CHECKO_KEY в .env файле' } };
  }
  try {
    const res = await axios.get(`${CHECKO_BASE}/company`, {
      params: { key: CHECKO_KEY, inn },
      timeout: 15000
    });
    console.log('Checko response:', res.data);
    return { name: 'Checko', ok: true, items: res.data };
  } catch (err) {
    console.error('Checko error:', err.response?.data || err.message);
    return { name: 'Checko', ok: false, error: normalizeError(err) };
  }
}

app.post('/api/company-search', async (req, res) => {
  try {
    const { inn } = req.body || {};
    if (!inn || !/^\d{10,12}$/.test(String(inn).trim())) {
      return res.status(400).json({ error: 'Введите корректный ИНН (10 или 12 цифр)' });
    }
    const steps = [];
    steps.push(await searchDatanewton(inn));
    steps.push(await searchChecko(inn));
    res.json({ query: String(inn).trim(), field: 'inn', results: steps });
  } catch (e) {
    res.status(500).json({ error: normalizeError(e) });
  }
});

// Новый эндпоинт для последовательного поиска по компаниям
app.post('/api/company-search-step', async (req, res) => {
  try {
    const { inn, step } = req.body || {};
    if (!inn || !/^\d{10,12}$/.test(String(inn).trim())) {
      return res.status(400).json({ error: 'Введите корректный ИНН (10 или 12 цифр)' });
    }
    
    let result;
    switch (step) {
      case 1:
        console.log('🔍 Step 1: Searching Datanewton...');
        result = await searchDatanewton(inn);
        break;
      case 2:
        console.log('🔍 Step 2: Searching Checko...');
        result = await searchChecko(inn);
        break;
      default:
        return res.status(400).json({ error: 'Invalid step' });
    }
    
    res.json({ 
      query: String(inn).trim(), 
      field: 'inn', 
      step,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: normalizeError(e) });
  }
});

// Новый эндпоинт для последовательного поиска утечек
app.post('/api/leak-search-step', async (req, res) => {
  try {
    const { query, field, step } = req.body || {};
    if (!query || typeof query !== 'string' || query.trim().length < 3) {
      return res.status(400).json({ error: 'Введите корректный запрос (мин. 3 символа)' });
    }
    
    const allowedFields = new Set(['phone', 'email', 'vk', 'ok', 'inn', 'snils']);
    const f = allowedFields.has(field) ? field : 'full_text';
    const finalQuery = extractUsernameIfSocial(f, query);
    
    let result;
    switch (step) {
      case 1:
        console.log('🔍 Step 1: Searching ITP...');
        result = await searchITP(finalQuery, f);
        break;
      case 2:
        console.log('🔍 Step 2: Searching Dyxless...');
        result = await searchDyxless(finalQuery);
        break;
      case 3:
        console.log('🔍 Step 3: Searching LeakOsint...');
        result = await searchLeakOsint(finalQuery);
        break;
      case 4:
        console.log('🔍 Step 4: Searching Usersbox...');
        result = await searchUsersbox(finalQuery);
        break;
      case 5:
        console.log('🔍 Step 5: Searching Vektor...');
        result = await searchVektor(finalQuery);
        break;
      default:
        return res.status(400).json({ error: 'Invalid step' });
    }
    
    res.json({ 
      query: finalQuery, 
      field: f, 
      step,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: normalizeError(e) });
  }
});

app.post('/api/company-summarize', async (req, res) => {
  try {
    console.log('Company summarize request received');
    const { inn, results } = req.body || {};
    console.log('Request data:', { inn, resultsLength: results?.length });
    
    if (!inn || !Array.isArray(results)) {
      console.log('Missing inn or results');
      return res.status(400).json({ error: 'Missing inn or results' });
    }

    // Проверяем доступность OpenAI
    console.log('🔍 Checking OpenAI availability...');
    console.log('OpenAI client exists:', !!openai);
    console.log('OpenAI API key exists:', !!OPENAI_API_KEY);
    
    if (!openai) {
      console.log('❌ OpenAI not available, using fallback');
      return res.json({ 
        ok: true, 
        model: 'fallback', 
        summary: createFallbackSummary(inn, results, {})
      });
    }
    
    console.log('Starting OpenAI request...');
    const system = 'Ты — эксперт-аналитик корпоративных данных с использованием GPT-5. Твоя задача — создать максимально полную и структурированную сводку о компании для красивого отображения в интерфейсе.';
    const instruction = {
      task: 'Проанализируй и объедини данные о компании из всех источников (Datanewton, Checko). Создай полную структурированную сводку для красивого отображения в UI.',
      language: 'ru',
      enhanced_processing: 'Используй возможности GPT-5 для глубокого анализа и нормализации данных',
      schema: {
        company: {
          name: 'string|null - приоритет краткому названию', 
          fullName: 'string|null - полное официальное название', 
          shortName: 'string|null - краткое название',
          inn: 'string|null - нормализованный ИНН', 
          ogrn: 'string|null - нормализованный ОГРН', 
          kpp: 'string|null',
          opf: 'string|null - организационно-правовая форма', 
          registration_date: 'string|null - дата в формате YYYY-MM-DD или DD.MM.YYYY', 
          years_from_registration: 'number|null - количество лет с регистрации',
          status: 'string|null - статус: Действует/Ликвидирована/и т.д.',
          address: 'string|null - полный нормализованный адрес',
          charter_capital: 'string|null - уставной капитал с валютой',
          contacts: { 
            phones: 'string[] - нормализованные телефоны в формате +7(XXX)XXX-XX-XX', 
            emails: 'string[] - валидные email адреса', 
            sites: 'string[] - веб-сайты без http/https префикса' 
          }
        },
        ceo: { 
          name: 'string|null - ФИО руководителя', 
          fio: 'string|null - альтернативное поле ФИО', 
          position: 'string|null - должность', 
          post: 'string|null - альтернативное поле должности' 
        },
        managers: '[{ name: string, fio?: string, position?: string, post?: string }] - все руководители',
        owners: '[{ name: string, type?: string, inn?: string, share_text?: string, share_percent?: number }] - учредители и владельцы',
        okved: { 
          main: '{ code?: string, text?: string, title?: string } - основной ОКВЭД', 
          additional: '[{ code?: string, text?: string, title?: string }] - дополнительные ОКВЭДы' 
        },
        risk_flags: 'string[] - флаги рисков и негативные факторы',
        notes: 'string[] - дополнительные заметки и важная информация',
        former_names: 'string[] - прежние названия компании',
        predecessors: 'string[] - предшественники'
      },
      rules: [
        'Используй возможности GPT-5 для максимально точной обработки данных',
        'Отвечай строго JSON без комментариев и дополнительного текста',
        'Объединяй данные из всех источников, приоритет более полным данным',
        'Удаляй дубликаты и нормализуй форматы (телефоны, даты, адреса)',
        'Если данные противоречат друг другу, выбирай наиболее достоверные',
        'Заполняй years_from_registration на основе registration_date',
        'Нормализуй телефоны в российский формат +7(XXX)XXX-XX-XX',
        'Если поле недоступно — ставь null или пустой массив',
        'Добавляй в risk_flags любые негативные факторы из источников',
        'В notes включай важную дополнительную информацию'
      ],
      inn,
      sources: results
    };

    // Используем новый API для GPT-5
    console.log('🚀 Attempting to use GPT-5 API...');
    console.log('Model from env:', process.env.OPENAI_MODEL);
    console.log('Final model decision:', process.env.OPENAI_MODEL || 'gpt-5');
    
    if ((process.env.OPENAI_MODEL || 'gpt-5') === 'gpt-5') {
      try {
        console.log('📡 Sending request to GPT-5 Responses API...');
        
        // Создаем промис с таймаутом
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('OpenAI request timeout (45s)')), 45000);
        });
        
        const openaiPromise = openai.responses.create({
          model: 'gpt-5',
          input: `${system}\n\n${JSON.stringify(instruction)}`
        });
        
        const response = await Promise.race([openaiPromise, timeoutPromise]);
        console.log('✅ GPT-5 response received successfully');
        const msg = response.output_text || '{}';
        let parsed; 
        try { 
          parsed = JSON.parse(msg); 
        } catch { 
          parsed = { raw: msg }; 
        }
        console.log('📊 GPT-5 response parsed, sending to client');
        res.json({ ok: true, model: 'gpt-5', summary: parsed });
      } catch (gpt5Error) {
        console.log('❌ GPT-5 API failed, falling back to chat completions:', gpt5Error.message);
        console.log('🔄 Attempting fallback to GPT-4...');
        
        // Fallback to chat completions API с таймаутом
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('GPT-4 fallback timeout (30s)')), 30000);
        });
        
        const gpt4Promise = openai.chat.completions.create({
          model: 'gpt-4',
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(instruction) }
          ]
        });
        
        const completion = await Promise.race([gpt4Promise, timeoutPromise]);
        console.log('✅ GPT-4 fallback response received');
        const msg = completion.choices?.[0]?.message?.content || '{}';
        let parsed; 
        try { 
          parsed = JSON.parse(msg); 
        } catch { 
          parsed = { raw: msg }; 
        }
        console.log('📊 GPT-4 fallback response parsed, sending to client');
        res.json({ ok: true, model: 'gpt-4-fallback', summary: parsed });
      }
    } else {
      // Для других моделей используем старый API
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(instruction) }
        ]
      });
      const msg = completion.choices?.[0]?.message?.content || '{}';
      let parsed; 
      try { 
        parsed = JSON.parse(msg); 
      } catch { 
        parsed = { raw: msg }; 
      }
      res.json({ ok: true, model: process.env.OPENAI_MODEL || 'gpt-4', summary: parsed });
    }
  } catch (e) {
    console.error('Company summarize error:', e.message, e.stack);
    
    // Fallback: возвращаем базовую информацию без GPT
    res.json({ 
      ok: true, 
      model: 'fallback', 
      summary: createFallbackSummary(inn, results, {})
    });
  }
});

// Функция для создания fallback сводки без OpenAI
function createFallbackSummary(inn, results, companyData) {
  let fallbackSummary = {
    company: {
      name: "Информация недоступна",
      inn: inn,
      status: "Неизвестно",
      address: "Не указан",
      activity: "Не указана"
    },
    summary: "Базовая информация о компании получена из открытых источников."
  };
  
  // Попытаемся извлечь хотя бы базовую информацию из результатов
  try {
    for (const result of results) {
      if (result.ok && result.items) {
        const items = result.items;
        
        // Извлекаем название компании
        if (items.company_names?.short_name) {
          fallbackSummary.company.name = items.company_names.short_name;
        } else if (items.company_names?.full_name) {
          fallbackSummary.company.name = items.company_names.full_name;
        } else if (items.name) {
          fallbackSummary.company.name = items.name;
        }
        
        // Извлекаем адрес
        if (items.address?.line_address) {
          fallbackSummary.company.address = items.address.line_address;
        } else if (items.address) {
          fallbackSummary.company.address = items.address;
        }
        
        // Извлекаем деятельность
        if (items.okved_main?.value) {
          fallbackSummary.company.activity = items.okved_main.value;
        } else if (items.activity) {
          fallbackSummary.company.activity = items.activity;
        }
        
        // Извлекаем статус
        if (items.status) {
          fallbackSummary.company.status = items.status;
        } else if (items.state) {
          fallbackSummary.company.status = items.state;
        }
      }
    }
    
    // Создаем более информативную сводку
    if (fallbackSummary.company.name !== "Информация недоступна") {
      fallbackSummary.summary = `Компания ${fallbackSummary.company.name} с ИНН ${inn}. ` +
        `Статус: ${fallbackSummary.company.status}. ` +
        `Основная деятельность: ${fallbackSummary.company.activity}.`;
    }
  } catch (fallbackError) {
    console.error('Fallback error:', fallbackError);
  }
  
  return fallbackSummary;
}

// Функция для создания fallback сводки поиска утечек без OpenAI
function createLeakFallbackSummary(query, field, compact) {
  let found = false;
  let sources = {};
  let highlights = [];
  let person = {
    name: null,
    phones: [],
    emails: [],
    usernames: [],
    ids: [],
    addresses: []
  };

  // Анализируем результаты каждого источника
  for (const [sourceName, sourceData] of Object.entries(compact)) {
    if (sourceData.ok && sourceData.data) {
      found = true;
      let foundCount = 0;
      
      if (sourceName === 'ITP' && typeof sourceData.data === 'object') {
        for (const [category, items] of Object.entries(sourceData.data)) {
          if (Array.isArray(items) && items.length > 0) {
            foundCount += items.length;
            highlights.push(`${category}: ${items.length} записей`);
          }
        }
      } else if (Array.isArray(sourceData.data)) {
        foundCount = sourceData.data.length;
        if (foundCount > 0) {
          highlights.push(`${sourceName}: ${foundCount} записей`);
        }
      }
      
      sources[sourceName] = { foundCount, notes: foundCount > 0 ? 'Данные найдены' : 'Нет данных' };
    } else {
      sources[sourceName] = { foundCount: 0, notes: 'Источник недоступен или нет данных' };
    }
  }

  // Если ничего не найдено
  if (!found) {
    highlights.push('Информация по запросу не найдена');
  }

  return {
    found,
    sources,
    highlights,
    person
  };
}

function compactResults(results) {
  const out = {};
  for (const r of results || []) {
    if (!r || !r.name) continue;
    if (r.name === 'ITP') {
      const groups = r.items || {};
      const obj = {};
      const names = Object.keys(groups).slice(0, 3);
      for (const key of names) {
        const arr = Array.isArray(groups[key]?.data) ? groups[key].data.slice(0, 3) : [];
        obj[key] = arr;
      }
      out.ITP = { ok: r.ok, meta: r.meta, data: obj };
    } else if (r.name === 'Dyxless') {
      const arr = Array.isArray(r.items) ? r.items.slice(0, 8) : [];
      out.Dyxless = { ok: r.ok, meta: r.meta, data: arr };
    } else if (r.name === 'LeakOsint') {
      const arr = Array.isArray(r.items) ? r.items.slice(0, 3).map(g => ({ db: g.db, info: g.info, data: Array.isArray(g.data) ? g.data.slice(0, 3) : [] })) : [];
      out.LeakOsint = { ok: r.ok, data: arr };
    } else if (r.name === 'Usersbox') {
      const arr = Array.isArray(r.items) ? r.items.slice(0, 10) : [];
      out.Usersbox = { ok: r.ok, meta: r.meta, data: arr };
    } else if (r.name === 'Vektor') {
      out.Vektor = { ok: r.ok, data: r.items };
    }
  }
  return out;
}

function optimizeDataForAI(compact) {
  const optimized = {};
  
  for (const [sourceName, sourceData] of Object.entries(compact)) {
    if (!sourceData.ok || !sourceData.data) {
      optimized[sourceName] = { ok: false, count: 0 };
      continue;
    }
    
    const summary = { ok: true, count: 0, samples: [], databases: [] };
    
    if (sourceName === 'ITP') {
      for (const [groupName, records] of Object.entries(sourceData.data)) {
        if (Array.isArray(records)) {
          summary.count += records.length;
          summary.samples.push(...records.slice(0, 2)); // Только первые 2 записи
          summary.databases.push(groupName);
        }
      }
    } else if (sourceName === 'Dyxless') {
      if (Array.isArray(sourceData.data)) {
        summary.count = sourceData.data.length;
        summary.samples = sourceData.data.slice(0, 3); // Только первые 3 записи
        // Извлекаем уникальные базы данных
        const dbs = [...new Set(sourceData.data.map(r => r.database).filter(Boolean))];
        summary.databases = dbs.slice(0, 5); // Максимум 5 баз
      }
    } else if (sourceName === 'LeakOsint') {
      if (Array.isArray(sourceData.data)) {
        summary.databases = sourceData.data.map(leak => leak.db).filter(Boolean);
        summary.count = sourceData.data.reduce((sum, leak) => sum + (leak.data?.length || 0), 0);
        // Берем по одной записи из каждой базы
        sourceData.data.forEach(leak => {
          if (leak.data && leak.data.length > 0) {
            summary.samples.push(leak.data[0]);
          }
        });
      }
    } else if (sourceName === 'Usersbox') {
      if (Array.isArray(sourceData.data)) {
        summary.count = sourceData.data.length;
        summary.samples = sourceData.data.slice(0, 3);
      }
    } else if (sourceName === 'Vektor') {
      if (Array.isArray(sourceData.data)) {
        summary.count = sourceData.data.length;
        summary.samples = sourceData.data.slice(0, 3);
      } else if (sourceData.data) {
        summary.count = 1;
        summary.samples = [sourceData.data];
      }
    }
    
    optimized[sourceName] = summary;
  }
  
  return optimized;
}

// Функция для создания fallback сводки поиска утечек без OpenAI
function createLeakFallbackSummary(query, field, compact) {
  let found = false;
  let sources = {};
  let highlights = [];
  let person = {
    name: null,
    phones: [],
    emails: [],
    usernames: [],
    ids: [],
    addresses: []
  };

  // Анализируем результаты каждого источника
  for (const [sourceName, sourceData] of Object.entries(compact)) {
    if (sourceData.ok && sourceData.data) {
      found = true;
      let foundCount = 0;
      
      if (sourceName === 'ITP' && typeof sourceData.data === 'object') {
        for (const [category, items] of Object.entries(sourceData.data)) {
          if (Array.isArray(items) && items.length > 0) {
            foundCount += items.length;
            highlights.push(`${category}: ${items.length} записей`);
          }
        }
      } else if (Array.isArray(sourceData.data)) {
        foundCount = sourceData.data.length;
        if (foundCount > 0) {
          highlights.push(`${sourceName}: ${foundCount} записей`);
        }
      }
      
      sources[sourceName] = { foundCount, notes: foundCount > 0 ? 'Данные найдены' : 'Нет данных' };
    } else {
      sources[sourceName] = { foundCount: 0, notes: 'Источник недоступен или нет данных' };
    }
  }

  // Если ничего не найдено
  if (!found) {
    highlights.push('Информация по запросу не найдена');
  }

  return {
    found,
    sources,
    highlights,
    person,
    security_recommendations: {
      password_change_sites: [],
      immediate_actions: found ? ['Проверьте найденные данные', 'Рассмотрите смену паролей'] : [],
      general_advice: ['Используйте уникальные пароли', 'Включите двухфакторную аутентификацию']
    },
    risk_level: found ? 'medium' : 'low',
    summary: found ? 'Найдены утечки данных. Рекомендуется принять меры безопасности.' : 'Утечки данных не обнаружены.'
  };
}

app.post('/api/summarize', async (req, res) => {
  // Объявляем переменные в начале для доступности в catch блоке
  const { query, field, results } = req.body || {};
  
  try {
    if (!query || !Array.isArray(results)) {
      return res.status(400).json({ error: 'Missing query or results' });
    }

    const compact = compactResults(results);
    
    // Проверяем доступность OpenAI
    if (!openai) {
      console.log('OpenAI not available for summarize, using fallback');
      return res.json({ 
        ok: true, 
        model: 'fallback', 
        summary: createLeakFallbackSummary(query, field, compact)
      });
    }

    const system = 'Ты — аналитик утечек данных. Анализируй найденные данные и создавай краткие отчеты с рекомендациями.';
    
    // Оптимизируем данные перед отправкой в OpenAI
    const optimizedData = optimizeDataForAI(compact);
    
    const instruction = {
      task: 'Проанализируй найденные утечки и создай отчет с рекомендациями',
      language: 'ru',
      output_schema: {
        found: 'boolean',
        sources: 'map: имя источника -> { foundCount: number, databases: string[], notes: string }',
        highlights: 'string[] — ключевые находки',
        person: {
          name: 'string | null',
          phones: 'string[]',
          emails: 'string[]',
          usernames: 'string[]'
        },
        security_recommendations: {
          password_change_sites: 'string[]',
          immediate_actions: 'string[]'
        },
        risk_level: 'string — low/medium/high/critical',
        summary: 'string'
      },
      rules: [
        'Отвечай строго JSON',
        'Нормализуй телефоны и emails',
        'Удаляй дубликаты',
        'Определяй уровень риска',
        'Указывай конкретные сайты для смены паролей'
      ],
      query,
      field,
      data: optimizedData
    };

    // Создаем промис с таймаутом для summarize (увеличиваем до 60 секунд)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Summarize OpenAI timeout (60s)')), 60000);
    });
    
    const openaiPromise = openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-5',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(instruction) }
      ]
    });
    
    const completion = await Promise.race([openaiPromise, timeoutPromise]);

    const msg = completion.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(msg); } catch { parsed = { raw: msg }; }
    res.json({ ok: true, model: process.env.OPENAI_MODEL || 'gpt-5', summary: parsed });
  } catch (e) {
    console.error('Summarize error:', e.message);
    // Fallback при ошибке OpenAI - теперь переменные доступны
    res.json({ 
      ok: true, 
      model: 'fallback', 
      summary: createLeakFallbackSummary(query || '', field || 'full_text', compactResults(results || []))
    });
  }
});

// Эндпоинт для генерации полного отчета
app.post('/api/generate-full-report', async (req, res) => {
  try {
    const { query, field, results, mode } = req.body || {};
    
    if (!query || !Array.isArray(results)) {
      return res.status(400).json({ error: 'Missing query or results' });
    }

    console.log(`📊 Generating full report for ${mode} mode`);
    
    // Генерируем HTML отчет
    const reportHtml = generateReportHTML(query, field, results, mode);
    
    res.json({ 
      ok: true, 
      html: reportHtml,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('Report generation error:', e.message);
    res.status(500).json({ error: normalizeError(e) });
  }
});

// Функция для генерации HTML отчета
function generateReportHTML(query, field, results, mode) {
  const timestamp = new Date().toLocaleString('ru-RU');
  const isCompanyMode = mode === 'company';
  
  let html = `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DataTrace - Полный отчет</title>
    <link href="https://fonts.googleapis.com/css2?family=PT+Mono:wght@400&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { 
            font-family: 'PT Mono', monospace; 
            background: white; 
            color: black; 
            line-height: 1.6; 
            padding: 20px;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { 
            border-bottom: 2px solid #e5e7eb; 
            padding-bottom: 20px; 
            margin-bottom: 30px; 
        }
        .title { font-size: 2rem; font-weight: bold; margin-bottom: 10px; }
        .subtitle { color: #6b7280; margin-bottom: 10px; }
        .meta { font-size: 0.9rem; color: #9ca3af; }
        .source-section { 
            border: 2px solid #e5e7eb; 
            margin-bottom: 30px; 
            background: white;
        }
        .source-header { 
            background: #f9fafb; 
            padding: 15px 20px; 
            border-bottom: 1px solid #e5e7eb;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .source-name { font-weight: bold; font-size: 1.2rem; }
        .status-badge { 
            padding: 4px 12px; 
            font-size: 0.8rem; 
            font-weight: bold; 
            border-radius: 4px;
        }
        .status-success { background: #dcfce7; color: #166534; }
        .status-danger { background: #fecaca; color: #991b1b; }
        .status-warning { background: #fef3c7; color: #92400e; }
        .source-content { padding: 20px; }
        .data-grid { 
            display: grid; 
            grid-template-columns: 200px 1fr; 
            gap: 10px 20px; 
            margin-bottom: 20px;
        }
        .data-label { font-weight: 600; color: #6b7280; }
        .data-value { color: black; word-break: break-word; }
        .records-section { margin-top: 20px; }
        .record-item { 
            background: #f9fafb; 
            padding: 15px; 
            margin-bottom: 10px; 
            border-left: 4px solid #6b7280;
        }
        .no-data { 
            text-align: center; 
            color: #6b7280; 
            padding: 40px; 
            font-style: italic;
        }
        .print-btn { 
            position: fixed; 
            top: 20px; 
            right: 20px; 
            background: black; 
            color: white; 
            border: none; 
            padding: 10px 20px; 
            cursor: pointer; 
            font-family: 'PT Mono', monospace;
        }
        .print-btn:hover { background: #374151; }
        @media print {
            .print-btn { display: none; }
            .source-section { break-inside: avoid; }
        }
    </style>
</head>
<body>
    <button class="print-btn" onclick="window.print()">🖨️ ПЕЧАТЬ</button>
    
    <div class="container">
        <div class="header">
            <h1 class="title">DATATRACE - ПОЛНЫЙ ОТЧЕТ</h1>
            <div class="subtitle">${isCompanyMode ? 'Проверка компании' : 'Поиск утечек данных'}</div>
            <div class="meta">
                <strong>Запрос:</strong> ${query} | 
                <strong>Тип:</strong> ${field || 'Не указан'} | 
                <strong>Дата:</strong> ${timestamp}
            </div>
        </div>
        
        <div class="sources">
  `;

  // Добавляем данные по каждому источнику
  results.forEach((result, index) => {
    const sourceName = result.name || `Источник ${index + 1}`;
    const hasData = result.ok && result.items;
    const status = result.error ? 'warning' : hasData ? 'danger' : 'success';
    const statusText = result.error ? 'ОШИБКА' : hasData ? 'НАЙДЕНО' : 'ЧИСТО';
    const statusClass = `status-${status}`;

    html += `
        <div class="source-section">
            <div class="source-header">
                <div class="source-name">${sourceName}</div>
                <div class="status-badge ${statusClass}">${statusText}</div>
            </div>
            <div class="source-content">
    `;

    if (result.error) {
      html += `<div class="no-data">Ошибка: ${JSON.stringify(result.error)}</div>`;
    } else if (!hasData) {
      html += `<div class="no-data">Данные не найдены</div>`;
    } else {
      // Отображаем данные в зависимости от источника
      html += formatSourceDataForReport(sourceName, result.items);
    }

    html += `
            </div>
        </div>
    `;
  });

  html += `
        </div>
    </div>
    
    <script>
        // Автоматически фокусируемся на окне для удобства печати
        window.focus();
    </script>
</body>
</html>
  `;

  return html;
}

// Функция для форматирования данных источника в отчете
function formatSourceDataForReport(sourceName, items) {
  let html = '';

  if (sourceName === 'ITP' && typeof items === 'object') {
    for (const [groupName, groupData] of Object.entries(items)) {
      if (groupData && groupData.data && Array.isArray(groupData.data)) {
        html += `<h3>${groupName} (${groupData.data.length} записей)</h3>`;
        html += '<div class="records-section">';
        
        groupData.data.forEach((record, index) => {
          html += `<div class="record-item">`;
          html += `<strong>Запись ${index + 1}:</strong><br>`;
          
          if (typeof record === 'object') {
            for (const [key, value] of Object.entries(record)) {
              if (value) {
                html += `<strong>${key}:</strong> ${value}<br>`;
              }
            }
          } else {
            html += record;
          }
          
          html += `</div>`;
        });
        
        html += '</div>';
      }
    }
  } else if (Array.isArray(items)) {
    html += `<div class="data-grid">`;
    html += `<div class="data-label">Всего записей</div>`;
    html += `<div class="data-value">${items.length}</div>`;
    html += `</div>`;
    
    html += '<div class="records-section">';
    html += `<h3>Найденные записи:</h3>`;
    
    items.forEach((record, index) => {
      html += `<div class="record-item">`;
      html += `<strong>Запись ${index + 1}:</strong><br>`;
      
      if (typeof record === 'object') {
        for (const [key, value] of Object.entries(record)) {
          if (value && key !== 'password') { // Скрываем пароли в отчете
            html += `<strong>${key}:</strong> ${value}<br>`;
          } else if (key === 'password' && value) {
            html += `<strong>password:</strong> ${String(value).substring(0, 8)}...<br>`;
          }
        }
      } else {
        html += record;
      }
      
      html += `</div>`;
    });
    
    html += '</div>';
  } else if (typeof items === 'object') {
    html += '<div class="data-grid">';
    
    for (const [key, value] of Object.entries(items)) {
      if (value) {
        html += `<div class="data-label">${key}</div>`;
        html += `<div class="data-value">${Array.isArray(value) ? value.join(', ') : value}</div>`;
      }
    }
    
    html += '</div>';
  }

  return html;
}

// Новый эндпоинт для получения информации о компании (заглушка)
app.get('/api/company', async (req, res) => {
  try {
    const { inn } = req.query;
    if (!inn || !/^\d{10,12}$/.test(String(inn).trim())) {
      return res.status(400).json({ error: 'Введите корректный ИНН (10 или 12 цифр)' });
    }

    // Используем существующую логику поиска компании
    const steps = [];
    steps.push(await searchDatanewton(inn));
    steps.push(await searchChecko(inn));
    
    res.json({ 
      inn: String(inn).trim(), 
      results: steps,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: normalizeError(e) });
  }
});

// Новый эндпоинт для форматирования через OpenAI
app.post('/api/openai/format-company', async (req, res) => {
  try {
    console.log('Received OpenAI format request:', req.body);
    const { prompt, model = 'gpt-5' } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Проверяем доступность OpenAI
    if (!openai) {
      console.log('OpenAI not available for formatting, using fallback HTML');
      return res.json({ 
        html: '<div class="p-4 bg-yellow-100 border border-yellow-400 rounded"><p class="text-yellow-800">OpenAI недоступен. Показаны базовые данные.</p></div>',
        model: 'fallback',
        timestamp: new Date().toISOString()
      });
    }

    console.log('Sending request to OpenAI with model:', process.env.OPENAI_MODEL || model);
    
    // Используем новый API для GPT-5
    if ((process.env.OPENAI_MODEL || model) === 'gpt-5') {
      try {
        const response = await openai.responses.create({
          model: 'gpt-5',
          input: `Ты — ассистент для визуализации данных компаний. Превращай JSON с информацией о компании в структурированное и красиво оформленное HTML-описание с классами Tailwind CSS. Используй только безопасный HTML без script тегов.\n\n${prompt}`
        });
        
        const htmlContent = response.output_text || '';
        console.log('OpenAI GPT-5 response received, HTML length:', htmlContent.length);
        
        res.json({ 
          html: htmlContent,
          model: 'gpt-5',
          timestamp: new Date().toISOString()
        });
      } catch (gpt5Error) {
        console.log('GPT-5 API failed, falling back to chat completions:', gpt5Error.message);
        // Fallback to chat completions API
        const completion = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [
            { 
              role: 'system', 
              content: 'Ты — ассистент для визуализации данных компаний. Превращай JSON с информацией о компании в структурированное и красиво оформленное HTML-описание с классами Tailwind CSS. Используй только безопасный HTML без script тегов.' 
            },
            { role: 'user', content: prompt }
          ]
        });

        const htmlContent = completion.choices?.[0]?.message?.content || '';
        res.json({ 
          html: htmlContent,
          model: 'gpt-4-fallback',
          timestamp: new Date().toISOString()
        });
      }
    } else {
      // Для других моделей используем старый API
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || model,
        messages: [
          { 
            role: 'system', 
            content: 'Ты — ассистент для визуализации данных компаний. Превращай JSON с информацией о компании в структурированное и красиво оформленное HTML-описание с классами Tailwind CSS. Используй только безопасный HTML без script тегов.' 
          },
          { role: 'user', content: prompt }
        ]
      });

      const htmlContent = completion.choices?.[0]?.message?.content || '';
      console.log('OpenAI response received, HTML length:', htmlContent.length);
      
      res.json({ 
        html: htmlContent,
        model: process.env.OPENAI_MODEL || model,
        timestamp: new Date().toISOString()
      });
    }
  } catch (e) {
    console.error('OpenAI formatting error:', e);
    // Fallback HTML при ошибке
    res.json({ 
      html: '<div class="p-4 bg-red-100 border border-red-400 rounded"><p class="text-red-800">Ошибка форматирования данных. Попробуйте позже.</p></div>',
      model: 'fallback',
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, version: '2.0', design: 'modern' }));

// Новый дизайн на отдельном endpoint
app.get('/modern', (_req, res) => {
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.sendFile(path.join(__dirname, '..', 'public', 'datatrace-modern.html'));
});

// Старый дизайн для отладки
app.get('/old', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'datatrace-styled.html'));
});

app.get('*', (_req, res) => {
  // Отключаем кеширование
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.sendFile(path.join(__dirname, '..', 'public', 'datatrace-modern.html'));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});


