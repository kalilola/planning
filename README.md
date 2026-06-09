# Planning Notion Widget

Widget embarqué dans Notion pour planifier des créneaux de travail avec tâches et sous-tâches.

## Structure

```
planning/
├── public/
│   └── index.html      ← Le widget affiché dans Notion
├── src/
│   └── server.js       ← Serveur Express + API Notion
├── package.json
├── .env.example
└── .gitignore
```

## Déploiement sur Render

1. Push ce repo sur GitHub
2. Sur [render.com](https://render.com) → New → Web Service → connecte ton repo
3. Paramètres :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Environment Variables** : ajoute `NOTION_TOKEN` = ton token secret Notion
4. Deploy → copie l'URL (ex: `https://planning-xxxx.onrender.com`)

## Intégration dans Notion

Dans ta page Planning :
1. Tape `/embed`
2. Colle l'URL de ton app Render
3. Le widget apparaît directement dans la page

## Développement local

```bash
npm install
cp .env.example .env
# Remplis NOTION_TOKEN dans .env
npm run dev
```
