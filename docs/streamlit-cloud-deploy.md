# Deploying the dashboard to Streamlit Community Cloud

## 1. Sign up & connect

- Go to https://share.streamlit.io
- Click "Sign in with GitHub"
- Authorize Streamlit to access the `music-tracker` repo (read-only public access is sufficient since the repo is public)

## 2. Create the app

- Click "New app" → "Deploy a public app from GitHub"
- Repository: `steynvg00/music-tracker`
- Branch: `main`
- Main file path: `app.py`
- App URL: leave default or customize (something like `music-tracker-steynvg00`)
- Click "Advanced settings" → Python version: 3.12 (Streamlit Cloud may default to a different version)
- Don't click Deploy yet

## 3. Add the secret

- Still in Advanced settings, find the **Secrets** field
- Paste:
```toml
DATABASE_URL = "your-supabase-pooler-url-here"
```
- Use the same `DATABASE_URL` value from the local `.env`
- Click **Save**

## 4. Deploy

- Click **Deploy**
- Streamlit Cloud will install dependencies from `pyproject.toml` (this takes 1-3 minutes on first deploy)
- When the build completes, the dashboard URL becomes live
- Visit the URL — the dashboard should render exactly like local with all the metrics, top tracks, top artists tables

## 5. Add to phone home screen

- Open the deployed URL in Safari (iPhone) / Chrome (Android)
- Tap the share button → "Add to Home Screen"
- The dashboard now has a phone-app-style icon

## 6. Troubleshooting

- **"App is sleeping" message** → Streamlit Cloud apps sleep after 7 days of no traffic. One click to wake up. Same behavior as Supabase free tier.
- **"Connection refused"** → `DATABASE_URL` incorrect or Supabase project paused. Check Supabase dashboard.
- **Dashboard shows old data** → Streamlit Cloud caches via `@st.cache_data(ttl=60)`. Hit the Refresh button in the sidebar.
