const express = require('express');
const cors = require('cors');
const { Client } = require('@notionhq/client');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// IDs des bases de données
const SUIVI_TACHES_DB = '210b8c920bd2801bac30d7c6fc55d802';
const SOUS_TACHES_DB  = '2acb8c920bd2802bba52c6525a3e251c';
const PLANNING_DB     = '20fedb5f2de84970a8d8bc6afd3007b6';

// ─── GET /api/taches ───────────────────────────────────────────────────────────
// Retourne toutes les tâches parentes (sans tâche parent = tâches racines)
app.get('/api/taches', async (req, res) => {
  try {
    const response = await notion.databases.query({
      database_id: SUIVI_TACHES_DB,
      filter: {
        and: [
          {
            property: 'tâche parent',
            relation: { is_empty: true }
          },
          {
            property: 'État',
            status: {
              does_not_equal: 'hide'
            }
          }
        ]
      },
      sorts: [{ property: 'Nom de la tâche', direction: 'ascending' }]
    });

    const taches = response.results.map(page => ({
      id: page.id,
      nom: page.properties['Nom de la tâche']?.title?.[0]?.plain_text || '(sans nom)',
      etat: page.properties['État']?.status?.name || '',
      url: page.url
    }));

    res.json(taches);
  } catch (err) {
    console.error('Erreur /api/taches:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/taches/:id/sous-taches ──────────────────────────────────────────
// Retourne les sous-tâches d'une tâche (depuis Suivi des tâches via tâche parent)
// ET les sous-tâches de la base "sous taches" via sous tache parent
app.get('/api/taches/:id/sous-taches', async (req, res) => {
  const { id } = req.params;
  try {
    // 1. Sous-tâches dans Suivi des tâches (auto-relation tâche parent)
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

    // 2. Sous-tâches dans la base "sous taches" (relation sous tache parent)
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
// Crée les entrées dans la base Planning
// Body: { tacheId, sousTaches: [{id, source}], date, heureDebut, heureFin, notes }
app.post('/api/planifier', async (req, res) => {
  const { tacheId, sousTaches, date, heureDebut, heureFin, notes } = req.body;

  if (!tacheId || !date || !heureDebut || !heureFin) {
    return res.status(400).json({ error: 'Champs manquants: tacheId, date, heureDebut, heureFin requis' });
  }

  const debutISO = `${date}T${heureDebut}:00.000+02:00`;
  const finISO   = `${date}T${heureFin}:00.000+02:00`;

  try {
    // Récupère le nom de la tâche principale
    const tachePage = await notion.pages.retrieve({ page_id: tacheId });
    const nomTache = tachePage.properties['Nom de la tâche']?.title?.[0]?.plain_text || 'Tâche';

    const creees = [];

    // Entrée principale pour la tâche
    const entreeBase = {
      parent: { database_id: PLANNING_DB },
      properties: {
        'Nom': {
          title: [{ text: { content: nomTache } }]
        },
        'Tache liee': {
          relation: [{ id: tacheId }]
        },
        'Creneau debut': {
          date: { start: debutISO }
        },
        'Creneau fin': {
          date: { start: finISO }
        },
        'État': {
          select: { name: 'Planifié' }
        },
        ...(notes ? { 'Notes': { rich_text: [{ text: { content: notes } }] } } : {})
      }
    };

    const pageCreee = await notion.pages.create(entreeBase);
    creees.push({ nom: nomTache, id: pageCreee.id });

    // Entrées pour chaque sous-tâche sélectionnée
    for (const st of (sousTaches || [])) {
      let nomST = st.nom || 'Sous-tâche';

      const propSousTache = st.source === 'suivi'
        ? { 'Tache liee':      { relation: [{ id: st.id }] } }
        : { 'Sous-tache liee': { relation: [{ id: st.id }] } };

      const entreeST = {
        parent: { database_id: PLANNING_DB },
        properties: {
          'Nom': {
            title: [{ text: { content: `↳ ${nomST}` } }]
          },
          ...propSousTache,
          'Creneau debut': {
            date: { start: debutISO }
          },
          'Creneau fin': {
            date: { start: finISO }
          },
          'État': {
            select: { name: 'Planifié' }
          }
        }
      };

      const stCreee = await notion.pages.create(entreeST);
      creees.push({ nom: nomST, id: stCreee.id });
    }

    res.json({ success: true, creees });
  } catch (err) {
    console.error('Erreur /api/planifier:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Démarrage ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Serveur démarré sur le port ${PORT}`);
});
