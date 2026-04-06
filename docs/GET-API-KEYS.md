# Get API Keys for Refactory

You only need **one** key to start. The router falls back automatically across providers.

**Get Groq first** -- it has the best free tier for code tasks (32k output tokens, fast inference).

---

## 1. Groq (Recommended)

Best for: fast code generation with Llama 3.3 70B, 32k max output tokens.

1. Go to https://console.groq.com/keys
2. Sign up with Google or GitHub
3. You land on the Dashboard -- click **API Keys** in the left sidebar
4. Click **Create API Key**, give it a name
5. Copy the key (starts with `gsk_`)

```bash
export GROQ_API_KEY=gsk_your_key_here
```

**Free tier limits:** 30 requests/min, 14,400 requests/day, 6,000 tokens/min on Llama 3.3 70B.

---

## 2. Google Gemini

Best for: large file analysis with 1M token context window.

1. Go to https://aistudio.google.com/app/apikey
2. Sign in with your Google account
3. Click **Get API Key** then **Create API Key**
4. Select a Google Cloud project (or create one -- no billing required)
5. Copy the key (starts with `AIza`)

```bash
export GOOGLE_API_KEY=AIza_your_key_here
```

**Free tier limits:** 10 requests/min, 250 requests/day on Gemini 2.5 Flash.

---

## 3. OpenRouter

Best for: access to many models through one key. Qwen 3.6 Plus is free with 1M context.

1. Go to https://openrouter.ai/settings/keys
2. Sign up (email or OAuth)
3. Go to **Settings** > **API Keys**
4. Click **Create Key**, give it a name
5. Copy the key (starts with `sk-or-`)

```bash
export OPENROUTER_API_KEY=sk-or-your_key_here
```

**Free tier limits:** varies by model. Qwen 3.6 Plus: free, 600 requests/min.

---

## 4. SambaNova

Best for: MiniMax model with 163k context.

1. Go to https://cloud.sambanova.ai/apis
2. Sign up for an account
3. Navigate to the **API** section
4. Click **Create Key** and copy it

```bash
export SAMBANOVA_API_KEY=your_key_here
```

**Free tier limits:** rate limited but generous (no hard daily cap published).

---

## Setting Keys Permanently

**Option A -- `.env` file (recommended):**

Create a `.env` file in the Refactory project root:

```
GROQ_API_KEY=gsk_your_key_here
GOOGLE_API_KEY=AIza_your_key_here
```

**Option B -- shell profile:**

Add export lines to `~/.bashrc` (Linux/Mac) or `~/.zshrc` (Mac):

```bash
export GROQ_API_KEY=gsk_your_key_here
```

Then restart your terminal or run `source ~/.bashrc`.

---

## Verify Your Key Works

```bash
node src/cli.js providers
```

This shows which providers are configured and reachable. If a provider shows as available, you're good.

---

## Summary

| Provider | Context | Max Output | Free Limit | Get First? |
|----------|---------|-----------|------------|------------|
| Groq | 128k | 32k | 14,400/day | Yes |
| Gemini | 1M | 65k | 250/day | Second |
| OpenRouter | 1M | varies | 600 RPM | Third |
| SambaNova | 163k | varies | generous | Optional |

You only need one key. Start with Groq, add others later if you hit rate limits.
