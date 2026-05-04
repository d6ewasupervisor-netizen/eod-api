# Cloudflare Access auth — setup

The EOD frontend (`https://the-dump-bin.com/EOD/`) and this API
(`https://eod-api.the-dump-bin.com`) now both sit behind the same Cloudflare
Access policy as the rest of `the-dump-bin.com`. There is no app-level
password — Cloudflare Access handles the IdP login, and this API verifies the
forwarded JWT.

This is a one-time dashboard + Railway config that has to be done before the
new code will work in production.

## 1. Cloudflare DNS — add the API hostname

In the Cloudflare DNS dashboard for `the-dump-bin.com`, add a CNAME:

| Type  | Name      | Target                                      | Proxy |
| ----- | --------- | ------------------------------------------- | ----- |
| CNAME | `eod-api` | `eod-api-production.up.railway.app`         | ON    |

## 2. Railway — attach the custom domain

In the Railway dashboard for the EOD API service:

1. Settings → Domains → Custom Domain → `eod-api.the-dump-bin.com`.
2. Wait for the cert to provision.

## 3. Cloudflare Zero Trust — add the Access application

Cloudflare Zero Trust → Access → Applications → Add application → Self-hosted:

- Application domain: `eod-api.the-dump-bin.com` (whole hostname)
- Identity providers: same set used for the dump bin (e.g. Google Workspace)
- Policies: reuse the dump bin's "Retail Odyssey staff" policy
- Service Auth (optional): if you have automation hitting `/rebotics-auth-update`
  or `/api/auth-status` directly, create a service token and add a bypass policy
  that requires the `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.

After saving, click the new application → **Overview** tab → copy the
**Application Audience (AUD) Tag**.

## 4. Railway — environment variables

On the EOD API service in Railway, set:

```
CF_ACCESS_TEAM_DOMAIN=retailodyssey.cloudflareaccess.com   # your team domain
CF_ACCESS_AUD=<the AUD tag you just copied>
ALLOWED_ORIGINS=https://the-dump-bin.com
KOMPASS_ADMIN_EMAILS=tyson.gauthier@retailodyssey.com,...
KOMPASS_SUPERVISOR_EMAILS=...
KOMPASS_LEAD_EMAILS=...
EOD_APP_ALLOWED_EMAILS=aiyana.natarisalazar@retailodyssey.com,alex.wright2@retailodyssey.com,james.duchene@retailodyssey.com,jes.zumwalt@sasretailservices.com,ruth.northcutt@sasretailservices.com,d6ewa.supervisor@gmail.com
```

`EOD_APP_ALLOWED_EMAILS` is enforced in `auth-middleware.js` after the Access JWT
is verified. Keep it in sync with the `EOD_EMAIL_ALLOWLIST` array in
`the-dump-bin/EOD/index.html`.

Remove the now-unused `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` while
you're in there.

## 5. Smoke test

1. Visit `https://the-dump-bin.com/EOD/` in an incognito window.
2. Cloudflare Access should send you through the IdP login (or skip it if you
   already have a session from another the-dump-bin.com app).
3. The page should load and show your email under the EOD logo briefly before
   the overlay fades.
4. Check the browser console — no 401s. The first call to `/api/me` should
   return `{ email, roles, ... }`.

## How it fits together

- The browser holds a `CF_Authorization` cookie scoped to `the-dump-bin.com`.
- Static assets are served from `the-dump-bin.com/EOD/` (GitHub Pages → CF).
- Every `authFetch(...)` from the page goes to `eod-api.the-dump-bin.com` with
  `credentials: 'include'`, so the cookie rides along.
- Cloudflare Access on the API hostname verifies the cookie and forwards the
  request to Railway with a `Cf-Access-Jwt-Assertion` header.
- `auth-middleware.js` re-verifies that JWT against the team JWKS, populates
  `req.user.email`, and looks up `req.user.roles` from the env-var allowlists.

## If you ever rotate the Access app

Re-paste the new AUD into `CF_ACCESS_AUD` on Railway and redeploy. The team
domain only changes if you migrate Zero Trust accounts.

## Cloudflare AI — review `eod-api` Access (copy/paste)

Use this in the Cloudflare dashboard AI chat (or any assistant) to audit or
update Zero Trust for the EOD API hostname:

```
You are helping with Cloudflare Zero Trust (Access) for domain the-dump-bin.com.

1) List all Access applications that include hostname eod-api.the-dump-bin.com (exact or wildcard). For each app, show: name, session duration, allowed IdPs, and every policy in order (action, include rules, exclude rules, require rules).

2) Compare with how the main site the-dump-bin.com is protected. Should eod-api use the same broad “staff” policy or a tighter policy? Our goal: only these people may sign in to the EOD API (and EOD SPA): aiyana.natarisalazar@retailodyssey.com, alex.wright2@retailodyssey.com, james.duchene@retailodyssey.com, jes.zumwalt@sasretailservices.com, ruth.northcutt@sasretailservices.com, d6ewa.supervisor@gmail.com. If the current policy is wider, propose updated policies (Include → Emails) or Email domain rules that match exactly, including Gmail for d6ewa.supervisor@gmail.com.

3) Confirm the Application Audience (AUD) tag for the eod-api application matches what we use in Railway as CF_ACCESS_AUD for the eod-api service.

4) Note any Service Auth / bypass policies on eod-api that must stay for webhooks or automation; do not remove those without calling them out.

5) If anything should change, give step-by-step in the Cloudflare dashboard (clicks and fields), not generic advice.
```

After policy changes, confirm `Cf-Access-Jwt-Assertion` still reaches Railway and
`/api/me` returns 200 for an allowlisted test user and 403 for others once
`EOD_APP_ALLOWED_EMAILS` is set on Railway.
