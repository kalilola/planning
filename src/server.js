const express = require('express');
const cors = require('cors');
const { Client } = require('@notionhq/client');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Headers pour autoriser l'embed dans Notion
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ─── IDs des bases ─────────────────────────────────────────────────────────────
const SUIVI_TACHES_DB = '210b8c920bd2801bac30d7c6fc55d802';
const SOUS_TACHES_DB  = '2acb8c920bd2802bba52c6525a3e251c';
const FORMATIONS_DB   = '37cb8c920bd28024a757ecbfb3325760';
const COURS_DB        = '37cb8c920bd2800d8ce1f4e6f43ca36a';
const PLANNING_DB     = '37ab8c920bd28083865acb4fe899a3ca';

// ─── Configuration par source ───────────────────────────────────────────────────
// Décrit comment requêter/écrire selon que la source est "vyrexads" ou "formations"
const SOURCES = {
  vyrexads: {
    label: 'Vyrexads',
    mainDb: SUIVI_TACHES_DB,
    mainTitleProp: 'Nom de la tâche',
    mainStatusProp: 'État',
    mainPlanningRelation: 'Tache liee',     // propriété dans Planning -> tâche principale
    sousTaches: [
      {
        db: SUIVI_TACHES_DB,
        filterProp: 'tâche parent',
        titleProp: 'Nom de la tâche',
        statusProp: 'État',
        planningRelation: 'Tache liee',
        source: 'suivi'
      },
      {
        db: SOUS_TACHES_DB,
        filterProp: 'sous tache parent',
        titleProp: 'Nom',
        statusProp: 'État',
        planningRelation: 'Sous-tache liee',
        source: 'sous_taches'
      }
    ]
  },
  formations: {
    label: 'Formations',
    mainDb: FORMATIONS_DB,
    mainTitleProp: 'Nom',
    mainStatusProp: null,
    mainPlanningRelation: 'Formation liee',
    sousTaches: [
      {
        db: COURS_DB,
        filterProp: 'Formations',
        titleProp: 'Nom',
        statusProp: null,
        planningRelation: 'Cours liee',
        source: 'cours'
      }
    ]
  }
};

// ─── Helper : extrait l'icône d'une page Notion ───────────────────────────────
function extractIcon(page) {
  if (!page.icon) return null;
  if (page.icon.type === 'emoji') return { type: 'emoji', emoji: page.icon.emoji };
  if (page.icon.type === 'external') return { type: 'external', external: { url: page.icon.external.url } };
  return null;
}

function getTitle(page, prop) {
  return page.properties[prop]?.title?.[0]?.plain_text || '(sans nom)';
}

function getStatus(page, prop) {
  if (!prop) return '';
  return page.properties[prop]?.status?.name || '';
}

// ─── GET /api/sources ──────────────────────────────────────────────────────────
// Retourne la liste des sources disponibles
app.get('/api/sources', (req, res) => {
  res.json(Object.entries(SOURCES).map(([key, cfg]) => ({ key, label: cfg.label })));
});

// ─── GET /api/:source/items-a-planifier ────────────────────────────────────────
app.get('/api/:source/items-a-planifier', async (req, res) => {
  const cfg = SOURCES[req.params.source];
  if (!cfg) return res.status(400).json({ error: 'Source inconnue' });

  try {
    const response = await notion.databases.query({
      database_id: cfg.mainDb,
      filter: {
        property: 'A planifier',
        checkbox: { equals: true }
      },
      sorts: [{ property: cfg.mainTitleProp, direction: 'ascending' }]
    });

    const items = response.results.map(page => ({
      id: page.id,
      nom: getTitle(page, cfg.mainTitleProp),
      etat: getStatus(page, cfg.mainStatusProp),
    }));

    res.json(items);
  } catch (err) {
    console.error(`Erreur /api/${req.params.source}/items-a-planifier:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/:source/items/:id/sous-elements ──────────────────────────────────
app.get('/api/:source/items/:id/sous-elements', async (req, res) => {
  const cfg = SOURCES[req.params.source];
  if (!cfg) return res.status(400).json({ error: 'Source inconnue' });

  const { id } = req.params;
  try {
    let resultats = [];

    for (const st of cfg.sousTaches) {
      const r = await notion.databases.query({
        database_id: st.db,
        filter: {
          property: st.filterProp,
          relation: { contains: id }
        }
      });

      resultats = resultats.concat(r.results.map(page => ({
        id: page.id,
        nom: getTitle(page, st.titleProp),
        etat: getStatus(page, st.statusProp),
        icon: extractIcon(page),
        source: st.source
      })));
    }

    res.json(resultats);
  } catch (err) {
    console.error('Erreur sous-elements:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/:source/planifier ───────────────────────────────────────────────
app.post('/api/:source/planifier', async (req, res) => {
  const cfg = SOURCES[req.params.source];
  if (!cfg) return res.status(400).json({ error: 'Source inconnue' });

  const { itemId, sousElements, date, heureDebut, heureFin, notes } = req.body;

  if (!itemId || !date || !heureDebut || !heureFin) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  const debutISO = `${date}T${heureDebut}:00.000+02:00`;
  const finISO   = `${date}T${heureFin}:00.000+02:00`;

  try {
    const itemPage = await notion.pages.retrieve({ page_id: itemId });
    const nomItem  = getTitle(itemPage, cfg.mainTitleProp);
    const iconItem = extractIcon(itemPage);

    const creees = [];

    const pageCreee = await notion.pages.create({
      parent: { database_id: PLANNING_DB },
      ...(iconItem ? { icon: iconItem } : {}),
      properties: {
        'Nom':                     { title: [{ text: { content: nomItem } }] },
        [cfg.mainPlanningRelation]: { relation: [{ id: itemId }] },
        'Créneau':                 { date: { start: debutISO, end: finISO } },
        'Etat':                    { select: { name: 'Planifié' } },
        'Source':                  { select: { name: cfg.label } },
        ...(notes ? { 'Notes': { rich_text: [{ text: { content: notes } }] } } : {})
      }
    });
    creees.push({ nom: nomItem, id: pageCreee.id });

    for (const se of (sousElements || [])) {
      const stCfg = cfg.sousTaches.find(s => s.source === se.source);
      const propRelation = stCfg ? stCfg.planningRelation : cfg.mainPlanningRelation;

      // Récupère l'icône directement depuis l'API pour garantir la fraîcheur
      let iconSE = null;
      try {
        const sePage = await notion.pages.retrieve({ page_id: se.id });
        iconSE = extractIcon(sePage);
      } catch(_) {}

      const seCreee = await notion.pages.create({
        parent: { database_id: PLANNING_DB },
        ...(iconSE ? { icon: iconSE } : {}),
        properties: {
          'Nom':                   { title: [{ text: { content: se.nom } }] },
          [propRelation]:          { relation: [{ id: se.id }] },
          'Tache parent planning': { relation: [{ id: pageCreee.id }] },
          'Créneau':               { date: { start: debutISO, end: finISO } },
          'Etat':                  { select: { name: 'Planifié' } },
          'Source':                { select: { name: cfg.label } }
        }
      });
      creees.push({ nom: se.nom, id: seCreee.id });
    }

    // Décoche "A planifier"
    await notion.pages.update({
      page_id: itemId,
      properties: { 'A planifier': { checkbox: false } }
    });

    res.json({ success: true, creees });
  } catch (err) {
    console.error(`Erreur /api/${req.params.source}/planifier:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Serveur démarré sur le port ${PORT}`));