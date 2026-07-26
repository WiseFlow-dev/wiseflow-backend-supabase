<h1 align="center">WiseFlow Backend & Supabase Database Architecture</h1>

<p align="center">
  <b>PostgreSQL schema, database migrations, Row-Level Security (RLS) policies, and serverless Edge Functions for WiseFlow.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Database-PostgreSQL-blue.svg" alt="PostgreSQL"/>
  <img src="https://img.shields.io/badge/Platform-Supabase-emerald.svg" alt="Supabase"/>
  <img src="https://img.shields.io/badge/Security-Row%20Level%20Security-red.svg" alt="RLS"/>
  <img src="https://img.shields.io/badge/Runtime-Deno%20%7C%20Edge%20Functions-black.svg" alt="Deno Edge Functions"/>
</p>

---

## 🏛️ Architecture Overview

This repository contains the backend infrastructure for the WiseFlow personal finance platform:

- **Relational Schema**: Optimized PostgreSQL tables for multi-wallet tracking, categorized transactions, budget rules, and linked bank OAuth tokens.
- **Row-Level Security (RLS)**: Fine-grained security policies isolating user records at the database level.
- **Automated Database Migrations**: Sequential SQL migration scripts for schema evolution.
- **Serverless Edge Functions**: Lightweight Deno TypeScript functions executing webhook triggers and secure API integrations.

---

## 🛠️ Tech Stack

- **Supabase CLI**: Migration management & local database emulation
- **PostgreSQL 15**: Core relational storage engine
- **Deno / TypeScript**: Edge Functions runtime

---

## 🚀 Local Development

```bash
# Clone the repository
git clone https://github.com/WiseFlow-dev/wiseflow-backend-supabase.git

# Start local Supabase container stack
supabase start

# Apply database migrations
supabase db reset
```

---

## 📄 License

MIT License. See `LICENSE` for details.
