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

const SUIVI_TACHES_DB = '210b8c920bd2801bac30d7c6fc55d802';
const SOUS_TACHES_DB  = '2acb8c920bd2802bba52c6525a3e251c';
const PLANNING_DB     = '37ab8c920bd28083865acb4fe899a3ca';

// ─── GET /api/taches-a-planifier ──────────────────────────────────────────────
// Retourne TOUTES les tâches cochées "A planifier" (sans filtre tâche parent)
app.get('/api/taches-a-planifier', async (req, res) => {
  try {
    const response = await notion.databases.query({
      database_id: SUIVI_TACHES_DB,
      filter: {
        property: 'A planifier',
        checkbox: { equals: true }
      },
      sorts: [{ property: 'Nom de la tâche', direction: 'ascending' }]
    });

    const taches = response.results.map(page => ({
      id: page.id,
      nom: page.properties['Nom de la tâche']?.title?.[0]?.plain_text || '(sans nom)',
      etat: page.properties['État']?.status?.name || '',
    }));

    res.json(taches);
  } catch (err) {
    console.error('Erreur /api/taches-a-planifier:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/taches/:id/sous-taches ──────────────────────────────────────────
app.get('/api/taches/:id/sous-taches', async (req, res) => {
  const { id } = req.params;
  try {
    const suiviRes = await notion.databases.query({
      database_id: SUIVI_TACHES_DB,
      filter: {
        property: 'tâche parent',
        relation: { contains: id }
      }
    });

    const sousTachesSuivi = suiviRes.results.map(page => ({
      id: page.id,
      nom: page.properties['Nom de la tâche']?.title?.[0]?.plain_text || '(sans nom)',
      etat: page.properties['État']?.status?.name || '',
      source: 'suivi'
    }));

    const stRes = await notion.databases.query({
      database_id: SOUS_TACHES_DB,
      filter: {
        property: 'sous tache parent',
        relation: { contains: id }
      }
    });

    const sousTachesDB = stRes.results.map(page => ({
      id: page.id,
      nom: page.properties['Nom']?.title?.[0]?.plain_text || '(sans nom)',
      etat: page.properties['État']?.status?.name || '',
      source: 'sous_taches'
    }));

    res.json([...sousTachesSuivi, ...sousTachesDB]);
  } catch (err) {
    console.error('Erreur sous-taches:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/planifier ───────────────────────────────────────────────────────
app.post('/api/planifier', async (req, res) => {
  const { tacheId, sousTaches, date, heureDebut, heureFin, notes } = req.body;

  if (!tacheId || !date || !heureDebut || !heureFin) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  const debutISO = `${date}T${heureDebut}:00.000+02:00`;
  const finISO   = `${date}T${heureFin}:00.000+02:00`;

  try {
    const tachePage = await notion.pages.retrieve({ page_id: tacheId });
    const nomTache = tachePage.properties['Nom de la tâche']?.title?.[0]?.plain_text || 'Tâche';

    const creees = [];

    const pageCreee = await notion.pages.create({
      parent: { database_id: PLANNING_DB },
      properties: {
        'Nom':           { title: [{ text: { content: nomTache } }] },
        'Tache liee':    { relation: [{ id: tacheId }] },
        'Creneau debut': { date: { start: debutISO } },
        'Creneau fin':   { date: { start: finISO } },
        'Etat':          { select: { name: 'Planifié' } },
        ...(notes ? { 'Notes': { rich_text: [{ text: { content: notes } }] } } : {})
      }
    });
    creees.push({ nom: nomTache, id: pageCreee.id });

    for (const st of (sousTaches || [])) {
      const propST = st.source === 'suivi'
        ? { 'Tache liee':       { relation: [{ id: st.id }] } }
        : { 'Sous-tache liee':  { relation: [{ id: st.id }] } };

      const stCreee = await notion.pages.create({
        parent: { database_id: PLANNING_DB },
        properties: {
          'Nom':                  { title: [{ text: { content: st.nom } }] },
          ...propST,
          'Tache parent planning': { relation: [{ id: pageCreee.id }] },
          'Creneau debut':        { date: { start: debutISO } },
          'Creneau fin':          { date: { start: finISO } },
          'Etat':                 { select: { name: 'Planifié' } }
        }
      });
      creees.push({ nom: st.nom, id: stCreee.id });
    }

    // Décoche "A planifier"
    await notion.pages.update({
      page_id: tacheId,
      properties: { 'A planifier': { checkbox: false } }
    });

    res.json({ success: true, creees });
  } catch (err) {
    console.error('Erreur /api/planifier:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Serveur démarré sur le port ${PORT}`));
