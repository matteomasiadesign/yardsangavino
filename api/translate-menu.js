// api/translate-menu.js
// GET /api/translate-menu?lang=en
//
// Uso: prima apertura di una lingua sul menù pubblico (index.html).
// - Legge categorie/prodotti visibili direttamente da Supabase (fonte di verità,
//   non ci si fida del client).
// - Confronta con la cache: se una voce è già tradotta E il testo sorgente non è
//   cambiato, non viene ritradotta.
// - Le sole voci mancanti/obsolete vengono raggruppate in UNA chiamata Gemini.
// - Risultati salvati in cache (upsert, gestisce le race condition tramite il
//   vincolo unique a livello DB) e poi restituiti al frontend.

const { supabaseAdmin } = require('../lib/supabaseAdmin');
const { translateBatch } = require('../lib/gemini');

const SUPPORTED_LANGS = ['en', 'es', 'fr', 'de'];

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Metodo non consentito' });
    return;
  }

  const lang = String(req.query.lang || '').toLowerCase();
  if (!SUPPORTED_LANGS.includes(lang)) {
    res.status(400).json({ error: `Lingua non supportata: ${lang}` });
    return;
  }

  try {
    const [{ data: cats, error: catErr }, { data: prods, error: prodErr }] = await Promise.all([
      supabaseAdmin.from('categories').select('id, name').eq('is_visible', true),
      supabaseAdmin.from('products').select('id, name').eq('is_visible', true)
    ]);
    if (catErr) throw catErr;
    if (prodErr) throw prodErr;

    const [{ data: catCache, error: catCacheErr }, { data: prodCache, error: prodCacheErr }] = await Promise.all([
      supabaseAdmin.from('category_translation_cache').select('category_id, source_name, translated_name').eq('lang', lang),
      supabaseAdmin.from('product_translation_cache').select('product_id, source_name, translated_name').eq('lang', lang)
    ]);
    if (catCacheErr) throw catCacheErr;
    if (prodCacheErr) throw prodCacheErr;

    const catCacheMap = new Map(catCache.map(r => [r.category_id, r]));
    const prodCacheMap = new Map(prodCache.map(r => [r.product_id, r]));

    // Voci da tradurre: assenti in cache, oppure il nome italiano è cambiato
    // (rete di sicurezza in più rispetto all'invalidazione esplicita lato admin)
    const missingCats = cats.filter(c => {
      const cached = catCacheMap.get(c.id);
      return !cached || cached.source_name !== c.name;
    });
    const missingProds = prods.filter(p => {
      const cached = prodCacheMap.get(p.id);
      return !cached || cached.source_name !== p.name;
    });

    let translationFailed = false;

    if (missingCats.length || missingProds.length) {
      const batchItems = [
        ...missingCats.map(c => ({ id: `cat:${c.id}`, text: c.name })),
        ...missingProds.map(p => ({ id: `prod:${p.id}`, text: p.name }))
      ];

      try {
        const translatedMap = await translateBatch(lang, batchItems);

        const catUpserts = missingCats
          .filter(c => translatedMap.has(`cat:${c.id}`))
          .map(c => ({
            category_id: c.id,
            lang,
            source_name: c.name,
            translated_name: translatedMap.get(`cat:${c.id}`),
            updated_at: new Date().toISOString()
          }));

        const prodUpserts = missingProds
          .filter(p => translatedMap.has(`prod:${p.id}`))
          .map(p => ({
            product_id: p.id,
            lang,
            source_name: p.name,
            translated_name: translatedMap.get(`prod:${p.id}`),
            updated_at: new Date().toISOString()
          }));

        if (catUpserts.length) {
          const { error } = await supabaseAdmin
            .from('category_translation_cache')
            .upsert(catUpserts, { onConflict: 'category_id,lang' });
          if (error) throw error;
          catUpserts.forEach(u => catCacheMap.set(u.category_id, u));
        }

        if (prodUpserts.length) {
          const { error } = await supabaseAdmin
            .from('product_translation_cache')
            .upsert(prodUpserts, { onConflict: 'product_id,lang' });
          if (error) throw error;
          prodUpserts.forEach(u => prodCacheMap.set(u.product_id, u));
        }
      } catch (geminiErr) {
        // Fallback: Gemini non risponde/quota finita. Non blocchiamo la pagina:
        // le voci non tradotte verranno servite in italiano (vedi sotto) e il
        // frontend segnala che la traduzione è parziale.
        console.error('[translate-menu] Errore Gemini, fallback su italiano:', geminiErr);
        translationFailed = true;
      }
    }

    const categories = {};
    cats.forEach(c => {
      const cached = catCacheMap.get(c.id);
      categories[c.id] = cached ? cached.translated_name : c.name; // fallback IT
    });

    const products = {};
    prods.forEach(p => {
      const cached = prodCacheMap.get(p.id);
      products[p.id] = cached ? cached.translated_name : p.name; // fallback IT
    });

    res.status(200).json({ lang, categories, products, partial: translationFailed });
  } catch (err) {
    console.error('[translate-menu] Errore:', err);
    res.status(500).json({ error: 'Errore nel recupero/traduzione del menù.' });
  }
};
