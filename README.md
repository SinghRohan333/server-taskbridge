# TaskBridge — Server (Backend)

![Node.js](https://img.shields.io/badge/Node.js-Runtime-339933?logo=node.js)
![Express](https://img.shields.io/badge/Express-5-black?logo=express)
![MongoDB](https://img.shields.io/badge/MongoDB-Database-47A248?logo=mongodb)
![Stripe](https://img.shields.io/badge/Stripe-Payments-635BFF?logo=stripe)
![Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black?logo=vercel)

The REST API powering [TaskBridge](#links) — a freelance micro-task marketplace. Built with Express and MongoDB, it serves task, proposal, payment, review, notification, and admin-moderation endpoints to the [Next.js client](#links), with Stripe handling payments and JWT-based authentication validated against the client's identity provider.

---

## Links

|                        |                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------- |
| 🔗 Live API            | [server-taskbridge.vercel.app](https://server-taskbridge.vercel.app)               |
| 🖥️ Frontend Repository | [github.com/SinghRohan333/TaskBridge](https://github.com/SinghRohan333/TaskBridge) |

---

## Tech Stack

| Category          | Technology                          |
| ----------------- | ----------------------------------- |
| Runtime           | Node.js                             |
| Framework         | Express 5                           |
| Database          | MongoDB (native driver, no ODM)     |
| Payments          | Stripe Checkout                     |
| Auth Verification | JWT, verified via JWKS (`jose-cjs`) |
| Deployment        | Vercel (serverless functions)       |

---

## Project Structure

```
taskbridge-server/
├── public/
│   └── .gitkeep          # Reserved for static assets / required by Vercel
├── .env                  # Environment variables (not committed)
├── .gitignore
├── index.js               # Entire API — routes, middleware, DB setup
├── package.json
├── package-lock.json
└── vercel.json            # Vercel serverless deployment config
```

The entire API currently lives in a single `index.js` for simplicity, organized into clearly commented sections: connection setup, database seeding, auth middleware, and route groups (public tasks, freelancers, proposals, payments, reviews, notifications, bookmarks, and admin).

---

## Getting Started

### Prerequisites

- Node.js 18+
- A MongoDB connection string (shared with the frontend — same `taskbridge-db` database)
- A Stripe account (test mode keys are sufficient for development)
- The companion Next.js frontend running, since JWT verification depends on its JWKS endpoint

### Installation

```bash
git clone <repository-url>
cd taskbridge-server
npm install
```

### Environment Variables

Create a `.env` file in the project root:

```env
PORT=8000
MONGODB_URI=your_mongodb_connection_string
STRIPE_SECRET_KEY=your_stripe_secret_key
FRONTEND_URL=http://localhost:3000
```

| Variable            | Description                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`              | Port the Express server listens on (defaults to `8000`)                                                                                             |
| `MONGODB_URI`       | Shared database connection string                                                                                                                   |
| `STRIPE_SECRET_KEY` | Stripe secret key for creating Checkout sessions                                                                                                    |
| `FRONTEND_URL`      | Used for CORS origin, Stripe redirect URLs, **and** as the base for the JWKS endpoint (`${FRONTEND_URL}/api/auth/jwks`) that verifies incoming JWTs |

### Run the Server

```bash
npm run server   # dev, with nodemon
npm start        # production
```

On first boot, the server auto-creates required collections and indexes if they don't already exist — no manual migration step needed.

> **Note:** The admin account is _not_ seeded here. Because login is handled by Better Auth on the frontend, an admin user must be created through Better Auth so it has a valid password hash — see `scripts/seed-admin.mjs` in the **frontend** repository.

---

## Authentication & Security

- Clients authenticate against the Next.js app (Better Auth), which issues a short-lived, signed JWT in an `httpOnly`, `SameSite=Strict` cookie alongside its own session.
- This API does **not** mint or store its own JWTs — it verifies incoming tokens against the frontend's public JWKS endpoint (`${FRONTEND_URL}/api/auth/jwks`) using `jose-cjs`, so no shared secret needs to be configured here.
- `verifyJWT` middleware extracts and validates the token, then re-fetches the user's current record from MongoDB on every request — so a freshly blocked user loses API access immediately, without waiting for their token to expire.
- `requireRole([...])` middleware enforces role-based access (`client`, `freelancer`, `admin`) on top of a valid token.
- CORS is restricted to `FRONTEND_URL` with `credentials: true`, required for the cookie to be sent cross-origin during local development.

> Routes intended for a specific role (client/freelancer/admin actions) are designed to sit behind `verifyJWT` + `requireRole`. Before deploying, confirm `index.js` reflects full middleware coverage on every route in the reference below — a few endpoints from earlier project phases may still rely on a request-body identifier rather than the verified token and are worth a final pass.

---

## Database Schema

| Collection      | Key Fields                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `users`         | `name`, `email`, `image`, `role`, `skills[]`, `bio`, `hourlyRate`, `isBlocked`, `isVerified`, `bookmarks[]`        |
| `tasks`         | `title`, `category`, `description`, `budget`, `deadline`, `client_email`, `status`, `deliverable_url`, `createdAt` |
| `proposals`     | `task_id`, `freelancer_email`, `proposed_budget`, `estimated_days`, `cover_note`, `status`, `submitted_at`         |
| `payments`      | `client_email`, `freelancer_email`, `task_id`, `amount`, `transaction_id`, `payment_status`, `paid_at`             |
| `reviews`       | `task_id`, `reviewer_email`, `reviewee_email`, `rating`, `comment`, `created_at`                                   |
| `notifications` | `user_email`, `type`, `task_id`, `task_title`, `message`, `is_read`, `created_at`                                  |

`task.status` flows `open → in-progress → completed`. `proposal.status` flows `pending → accepted` / `rejected`.

---

## API Reference

All responses follow a consistent shape:

```json
{ "success": true, "...": "..." }
{ "success": false, "message": "Human-readable error" }
```

### Health

| Method | Endpoint | Auth   |
| ------ | -------- | ------ |
| GET    | `/`      | Public |

### Tasks — Public

| Method | Endpoint            | Description                                    | Auth   |
| ------ | ------------------- | ---------------------------------------------- | ------ |
| GET    | `/api/tasks`        | List open tasks — search, category, pagination | Public |
| GET    | `/api/tasks/latest` | Latest 6 open tasks (home page)                | Public |
| GET    | `/api/tasks/:id`    | Single task with client name joined            | Public |

### Tasks — Client

| Method | Endpoint                  | Description                                  | Auth      |
| ------ | ------------------------- | -------------------------------------------- | --------- |
| POST   | `/api/tasks`              | Create a task                                | 🔒 Client |
| PATCH  | `/api/tasks/:id`          | Edit a task (only while `open`)              | 🔒 Client |
| DELETE | `/api/tasks/:id`          | Delete a task (only if no accepted proposal) | 🔒 Client |
| GET    | `/api/tasks/mine`         | All tasks belonging to the logged-in client  | 🔒 Client |
| GET    | `/api/tasks/client-stats` | Task counts + total spent                    | 🔒 Client |

### Tasks — Freelancer

| Method | Endpoint                  | Description                                             | Auth          |
| ------ | ------------------------- | ------------------------------------------------------- | ------------- |
| GET    | `/api/tasks/active`       | In-progress / completed tasks with an accepted proposal | 🔒 Freelancer |
| PATCH  | `/api/tasks/:id/complete` | Submit deliverable URL, mark task completed             | 🔒 Freelancer |

### Freelancers — Public

| Method | Endpoint                     | Description                                               | Auth   |
| ------ | ---------------------------- | --------------------------------------------------------- | ------ |
| GET    | `/api/users/freelancers`     | All freelancers with average rating + completed job count | Public |
| GET    | `/api/users/freelancers/top` | Top 6 freelancers by rating                               | Public |
| GET    | `/api/users/freelancers/:id` | Single freelancer public profile                          | Public |

### Proposals

| Method | Endpoint                          | Description                                              | Auth          |
| ------ | --------------------------------- | -------------------------------------------------------- | ------------- |
| POST   | `/api/proposals`                  | Submit a proposal                                        | 🔒 Freelancer |
| GET    | `/api/proposals/check`            | Check if already applied to a task                       | Public        |
| GET    | `/api/proposals/mine`             | All proposals for the logged-in freelancer               | 🔒 Freelancer |
| GET    | `/api/proposals/freelancer-stats` | Proposal counts + total earnings                         | 🔒 Freelancer |
| GET    | `/api/proposals/client`           | All proposals, grouped by task, for the logged-in client | 🔒 Client     |
| PATCH  | `/api/proposals/:id/reject`       | Reject a proposal (notifies the freelancer)              | 🔒 Client     |

### Payments & Stripe

| Method | Endpoint                      | Description                                                                      | Auth          |
| ------ | ----------------------------- | -------------------------------------------------------------------------------- | ------------- |
| POST   | `/api/stripe/create-checkout` | Create a Stripe Checkout session for a proposal                                  | 🔒 Client     |
| GET    | `/api/stripe/confirm-session` | Confirm payment, accept proposal, reject others, notify all affected freelancers | 🔒 Client     |
| GET    | `/api/payments/client`        | Client payment history                                                           | 🔒 Client     |
| GET    | `/api/payments/freelancer`    | Freelancer earnings history                                                      | 🔒 Freelancer |

### Reviews

| Method | Endpoint              | Description                                     | Auth          |
| ------ | --------------------- | ----------------------------------------------- | ------------- |
| GET    | `/api/reviews`        | Reviews for a given `reviewee_email`            | Public        |
| GET    | `/api/reviews/check`  | Check if a reviewer already reviewed a task     | Public        |
| POST   | `/api/reviews`        | Client rates a freelancer after task completion | 🔒 Client     |
| POST   | `/api/reviews/client` | Freelancer rates a client after task completion | 🔒 Freelancer |

One review per task per reviewer is enforced on both endpoints.

### Notifications

| Method | Endpoint                  | Description                                 | Auth                      |
| ------ | ------------------------- | ------------------------------------------- | ------------------------- |
| GET    | `/api/notifications/mine` | Unread notifications for the logged-in user | 🔒 Any authenticated user |
| PATCH  | `/api/notifications/read` | Mark all notifications as read              | 🔒 Any authenticated user |

Notifications are created automatically when a proposal is accepted or rejected.

### Bookmarks

| Method | Endpoint                 | Description                                  | Auth          |
| ------ | ------------------------ | -------------------------------------------- | ------------- |
| POST   | `/api/bookmarks/:taskId` | Toggle a bookmark on a task                  | 🔒 Freelancer |
| GET    | `/api/bookmarks`         | Full task documents for all bookmarked tasks | 🔒 Freelancer |

### Profile

| Method | Endpoint        | Description                                  | Auth                      |
| ------ | --------------- | -------------------------------------------- | ------------------------- |
| PATCH  | `/api/users/me` | Update name, image, skills, bio, hourly rate | 🔒 Any authenticated user |

### Platform Stats

| Method | Endpoint     | Description                                       | Auth   |
| ------ | ------------ | ------------------------------------------------- | ------ |
| GET    | `/api/stats` | Total tasks, total users, total successful payout | Public |

### Admin

| Method | Endpoint                       | Description                               | Auth     |
| ------ | ------------------------------ | ----------------------------------------- | -------- |
| GET    | `/api/admin/stats`             | Total users, tasks, revenue, active tasks | 🔒 Admin |
| GET    | `/api/admin/users`             | All users (password fields excluded)      | 🔒 Admin |
| PATCH  | `/api/admin/users/:id/block`   | Block a non-admin user                    | 🔒 Admin |
| PATCH  | `/api/admin/users/:id/unblock` | Unblock a user                            | 🔒 Admin |
| PATCH  | `/api/admin/users/:id/verify`  | Verify a freelancer account               | 🔒 Admin |
| GET    | `/api/admin/tasks`             | All tasks, any status                     | 🔒 Admin |
| DELETE | `/api/admin/tasks/:id`         | Hard-delete any task                      | 🔒 Admin |
| GET    | `/api/admin/transactions`      | All payments platform-wide                | 🔒 Admin |

---

## Deployment

This project is configured for Vercel via `vercel.json`, deploying `index.js` as a serverless function. When deploying:

1. Set all four environment variables in the Vercel project settings.
2. Set `FRONTEND_URL` to your deployed frontend's production URL — both CORS and JWT verification depend on it being correct.
3. Confirm the deployed frontend's `NEXT_PUBLIC_API_URL` points back to this server's deployed URL.

---

## Author

Built by **Rohan Singh** as part of the TaskBridge assignment project.
