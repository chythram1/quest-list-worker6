# Quest List

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chythra-w1/quest-list-worker)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fchythra-w1%2Fquest-list-worker)

A fun Cloudflare Workers todo app using all three storage primitives:

- D1 stores todos.
- KV stores app preferences like the selected theme and daily vibe.
- R2 stores optional todo attachments.
- testing out changessss and sees what happens

## Setup

Install dependencies:

```sh
npm install
```

For deploy-button users, Cloudflare can provision D1, KV, and R2 automatically from `wrangler.toml`.

For manual setup, create Cloudflare resources:

```sh
wrangler d1 create quest-list-worker-TODO_DB
wrangler kv namespace create TODO_KV
wrangler r2 bucket create quest-list-worker-todo-bucket
```

Copy the generated D1 database ID, KV namespace ID, and R2 bucket name into `wrangler.toml` if you are not using automatic provisioning.

Create the database tables locally:

```sh
npm run db:migrate:local
```

For production, run the remote migration too:

```sh
npm run db:migrate:remote
```

Add the admin secret:

```sh
wrangler secret put ADMIN_TOKEN
```

For local development, copy `.dev.vars.example` to `.dev.vars` and change the token:

```txt
ADMIN_TOKEN=pick-a-local-secret
```

Run locally:

```sh
npm run dev
```

Deploy:

```sh
npm run deploy
```

## API

- `GET /` serves the app.
- `GET /api/config` returns app config, current theme, daily vibe, and upload limit.
- `GET /api/todos` lists todos.
- `POST /api/todos` creates a todo.
- `PATCH /api/todos/:id` updates a todo.
- `DELETE /api/todos/:id` deletes a todo and its R2 attachment.
- `POST /api/todos/:id/attachment` uploads an attachment to R2 with multipart field `file`.
- `GET /api/todos/:id/attachment` downloads an attachment from R2.
- `DELETE /api/todos/:id/attachment` removes an attachment from R2.
- `POST /api/theme` stores the selected theme in KV.
- `GET /api/admin/stats` returns protected stats when called with `Authorization: Bearer <ADMIN_TOKEN>`.
