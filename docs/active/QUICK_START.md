# ScanCheck Quick Start (Restructured Repo)

## 1) Install dependencies

```bash
pip install -r requirements.txt
cd apps/api
npm install
```

## 2) Start API and web dashboard

```bash
cd apps/api
npm start
```

The API serves the dashboard from `apps/web`.

## 3) Open dashboard

- `http://localhost:3000`

## Runtime locations

Runtime data is outside source folders by default:
- DB: `.runtime/data/scancheck.db`
- Uploads: `.runtime/data/uploads/`
- Logs: `.runtime/logs/`

You can override with environment variables in `.env.example`.
