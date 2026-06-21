// lib/gemini.js
// Logica di traduzione condivisa tra /api/translate-menu e /api/translate-item.
// Un'unica chiamata Gemini per N voci (categorie + prodotti insieme),
// con output JSON forzato via responseSchema per evitare parsing fragile.

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const LANG_NAMES = {
  en: 'inglese',
  es: 'spagnolo',
  fr: 'francese',
  de: 'tedesco'
};

/**
 * Costruisce il prompt per Gemini.
 * items: [{ id: string, text: string }]
 */
function buildPrompt(targetLangCode, items) {
  const targetLangName = LANG_NAMES[targetLangCode];
  if (!targetLangName) throw new Error(`Lingua non supportata: ${targetLangCode}`);

  const inputJSON = JSON.stringify(items.map(i => ({ id: i.id, text: i.text })));

  return `Sei un traduttore professionista specializzato in menu di ristoranti, bar e locali italiani.

Ricevi un elenco di voci di menu in lingua italiana (nomi di categorie e/o nomi di prodotti)
in formato JSON. Il tuo compito è tradurle in ${targetLangName}, mantenendo un linguaggio
naturale e appropriato per un menu.

REGOLE OBBLIGATORIE — NON TRADURRE MAI:
- nomi propri dei prodotti, nomi commerciali, marchi (brand)
- nomi registrati
- nomi di vini, di cantine, di produttori
- denominazioni DOP, DOC, DOCG, IGP
- nomi famosi di piatti o di cocktail
- nomi di pizze quando costituiscono il nome del prodotto
- qualsiasi altro nome proprio presente nel testo

ESEMPI DI TERMINI DA NON TRADURRE MAI (lasciali identici, lettera per lettera):
Coca-Cola, Nutella, Parmigiano Reggiano DOP, Franciacorta Bellavista, Dom Pérignon,
Barolo Gaja, Margherita, Carbonara, Negroni, Tiramisù, Mojito, Jagermeister, Baileys,
Sambuca, Branca Menta, Amaro del Capo, Mirto Rosso, Mirto Bianco, Montenegro

Se una voce è interamente un nome proprio o un marchio (es. "Jagermeister"), restituiscila
ESATTAMENTE invariata.
Se una voce contiene sia un nome proprio sia parole comuni (es. "Bruschetta al Pomodoro"),
traduci solo le parole comuni e lascia invariata la parte di nome proprio.
In caso di dubbio se un termine sia un nome proprio, NON tradurlo: meglio lasciarlo in
italiano che tradurre erroneamente un marchio o una denominazione.

FORMATO DI OUTPUT (obbligatorio):
Rispondi ESCLUSIVAMENTE con un array JSON valido, con lo stesso numero di elementi e nello
stesso ordine dell'input, in questo formato esatto:
[{"id": "<id originale>", "translated": "<testo tradotto o invariato>"}, ...]
Nessun testo aggiuntivo, nessuna spiegazione, nessun markdown, nessun blocco di codice.

INPUT:
${inputJSON}`;
}

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      id: { type: 'STRING' },
      translated: { type: 'STRING' }
    },
    required: ['id', 'translated']
  }
};

/**
 * Traduce un elenco di voci in una singola chiamata Gemini.
 * items: [{ id: string, text: string }]
 * Ritorna: Map<id, translatedText>
 */
async function translateBatch(targetLangCode, items) {
  if (!items.length) return new Map();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY non impostata nelle env var del progetto.');

  const prompt = buildPrompt(targetLangCode, items);

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA
    }
  };

  // Singolo retry con backoff su errori transitori (5xx / rete)
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API error ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error('Risposta Gemini priva di contenuto utilizzabile.');

      const parsed = JSON.parse(rawText);
      const map = new Map();
      for (const entry of parsed) {
        if (entry && typeof entry.id !== 'undefined') {
          map.set(String(entry.id), entry.translated);
        }
      }
      return map;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise(r => setTimeout(r, 500)); // backoff prima del retry
    }
  }
  throw lastErr;
}

module.exports = { translateBatch, LANG_NAMES };
