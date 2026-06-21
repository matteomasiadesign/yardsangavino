// api/translate-item.js
// POST /api/translate-item   body: { table: 'products' | 'categories', id: number }
// Header richiesto: Authorization: Bearer <access_token Supabase dell'admin loggato>
//
// Uso: chiamata da admin.html dopo addProduct / addCategory / saveProductEdit /
// saveCategoryEdit. Traduce SOLO l'elemento indicato, e SOLO nelle lingue già
// "abilitate" (= già presenti in cache per almeno un'altra voce, cioè già
// aperte da un visitatore). Se nessuna lingua è mai stata aperta, non chiama
// Gemini: non c'è nulla da tenere aggiornato.
//
// Eliminazione: NON gestita qui. Le righe di cache vengono rimosse
// automaticamente da Postgres via ON DELETE CASCADE (vedi migration.sql),
// quindi l'admin può continuare a chiamare semplicemente
// sb.from('products').delete()... senza alcuna modifica.

const { supabaseAdmin } = require('../lib/supabaseAdmin');
const { translateBatch } = require('../lib/gemini');

const SUPPORTED_LANGS = ['en', 'es', 'fr', 'de'];

const TABLE_CONFIG = {
  products: { cacheTable: 'product_translation_cache', fkColumn: 'product_id' },
  categories: { cacheTable: 'category_translation_cache', fkColumn: 'category_id' }
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Metodo non consentito' });
    return;
  }

  // --- Verifica che la richiesta arrivi da un admin autenticato ---
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Token mancante.' });
    return;
  }
  const { data: userData, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !userData?.user) {
    res.status(401).json({ error: 'Sessione non valida.' });
    return;
  }

  const { table, id } = req.body || {};
  const config = TABLE_CONFIG[table];
  if (!config || !id) {
    res.status(400).json({ error: 'Parametri non validi (table/id).' });
    return;
  }

  try {
    // Rileggiamo il nome direttamente dal DB: non ci fidiamo del valore
    // eventualmente inviato dal client.
    const { data: sourceRow, error: sourceErr } = await supabaseAdmin
      .from(table)
      .select('id, name')
      .eq('id', id)
      .single();
    if (sourceErr || !sourceRow) throw sourceErr || new Error('Elemento non trovato.');

    // Lingue già abilitate = lingue già presenti in una delle due cache,
    // per qualsiasi voce (segno che almeno un visitatore le ha già aperte).
    const [{ data: catLangs, error: catLangErr }, { data: prodLangs, error: prodLangErr }] = await Promise.all([
      supabaseAdmin.from('category_translation_cache').select('lang'),
      supabaseAdmin.from('product_translation_cache').select('lang')
    ]);
    if (catLangErr) throw catLangErr;
    if (prodLangErr) throw prodLangErr;

    const enabledLangs = [...new Set([
      ...catLangs.map(r => r.lang),
      ...prodLangs.map(r => r.lang)
    ])].filter(l => SUPPORTED_LANGS.includes(l));

    if (enabledLangs.length === 0) {
      res.status(200).json({ translated: {}, langs: [], note: 'Nessuna lingua ancora abilitata, nessuna chiamata a Gemini.' });
      return;
    }

    // Una chiamata Gemini per ciascuna lingua già abilitata (in parallelo).
    // Ogni chiamata traduce una sola voce: costo minimo, frequenza bassa
    // (solo su add/edit dall'admin).
    const results = {};
    const failures = [];

    await Promise.all(enabledLangs.map(async (lang) => {
      try {
        const map = await translateBatch(lang, [{ id: String(sourceRow.id), text: sourceRow.name }]);
        const translated = map.get(String(sourceRow.id));
        if (!translated) throw new Error('Traduzione vuota.');

        const { error } = await supabaseAdmin
          .from(config.cacheTable)
          .upsert([{
            [config.fkColumn]: sourceRow.id,
            lang,
            source_name: sourceRow.name,
            translated_name: translated,
            updated_at: new Date().toISOString()
          }], { onConflict: `${config.fkColumn},lang` });
        if (error) throw error;

        results[lang] = translated;
      } catch (err) {
        // Una lingua fallita non blocca le altre. La voce mancante verrà
        // tradotta automaticamente alla prossima apertura di quella lingua
        // da parte di un visitatore (fallback gestito da /api/translate-menu).
        console.error(`[translate-item] Fallita traduzione lang=${lang}:`, err);
        failures.push(lang);
      }
    }));

    res.status(200).json({ translated: results, langs: enabledLangs, failures });
  } catch (err) {
    console.error('[translate-item] Errore:', err);
    res.status(500).json({ error: 'Errore durante la traduzione incrementale.' });
  }
};
