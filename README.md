<p align="center">
  <img src="architecture_banner.png" alt="Database Architecture Banner" width="100%"/>
</p>

<h1 align="center">WiseFlow Backend & Supabase Database Architecture</h1>

<p align="center">
  <b>PostgreSQL schema, database migrations, Row-Level Security (RLS) policies, and serverless Edge Functions.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Database-PostgreSQL%2015-blue?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL"/>
  <img src="https://img.shields.io/badge/Platform-Supabase-emerald?style=for-the-badge&logo=supabase&logoColor=3ECF8E" alt="Supabase"/>
  <img src="https://img.shields.io/badge/Security-Row%20Level%20Security-red?style=for-the-badge&logo=auth0&logoColor=white" alt="RLS"/>
  <img src="https://img.shields.io/badge/Runtime-Deno%20Edge%20Functions-black?style=for-the-badge&logo=deno&logoColor=white" alt="Deno"/>
</p>

---

## 🏛️ System Architecture & Database Capabilities

```
┌─────────────────────────────┬───────────────────────────────┬────────────────────────────┐
│ Relational PostgreSQL Schema│ Row-Level Security (RLS)      │ Deno Edge Functions        │
├─────────────────────────────┼───────────────────────────────┼────────────────────────────┤
│ 🗄️ Multi-wallet tracking    │ 🔒 Strict per-user isolation  │ ⚡ Webhook integrations    │
│ 💳 Linked bank OAuth tokens │ 🛡️ Fine-grained RPC policies   │ 🔑 Plaid / TrueLayer sync  │
└─────────────────────────────┴───────────────────────────────┴────────────────────────────┘
```

- **Migrations Engine**: 120+ sequential SQL migration scripts ensuring bulletproof schema versioning.
- **Row-Level Security**: Zero data leakage across tenant accounts enforced at the database kernel level.
- **Serverless Edge Functions**: Lightweight TypeScript microservices handling webhook callbacks and token exchange.

---

## 🚀 Local Setup

```bash
# Clone repository
git clone https://github.com/WiseFlow-dev/wiseflow-backend-supabase.git

# Start local Supabase emulation
supabase start

# Apply SQL migrations
supabase db reset
```

---

## 📄 License

MIT License © WiseFlow
