# Supported LLM Providers

Refactory is designed to work with **free-tier APIs**. The router automatically prioritizes providers based on their output limits and reliability.

## Recommended Setup

| Priority | Provider | Model | Output Limit | Best For |
|----------|----------|-------|--------------|----------|
| **1** | **Groq** | Llama 3.3 70B | **32k tokens** | Complex module extraction |
| **2** | **Google** | Gemini 2.5 Flash | 16k tokens | Planning, AST analysis |
| **3** | **OpenRouter** | Qwen 3.6 Plus | 16k tokens | Rate limit overflow |
| **4** | **SambaNova** | MiniMax | 16k tokens | Last resort fallback |

---

## 1. Groq (Primary)
- **Why**: The 32k output limit is essential. Standard 8k limits often truncate large code files.
- **How to get keys**: [console.groq.com](https://console.groq.com)
- **Rate Limit**: ~14,400 tokens per minute (RPM/TPM vary by model).

## 2. Google Gemini (Secondary)
- **Why**: Massive 1M context window. Excellent for analyzing the entire monolith at once.
- **How to get keys**: [aistudio.google.com](https://aistudio.google.com)
- **Rate Limit**: 15 requests per minute (Free tier).

## 3. OpenRouter (Tertiary)
- **Why**: Access to Qwen 3.6 Plus (free) which has excellent coding reasoning.
- **How to get keys**: [openrouter.ai](https://openrouter.ai)
- **Rate Limit**: Varies by model; usually very generous but slow.

---

## Configuration

Refactory searches for keys in this order:
1. Environment variables (`export GROQ_API_KEY=...`)
2. Local `.env` file in your project root.
3. System keychain (via `op` or `gh` if configured).

## Handling Rate Limits

If a provider returns a **429 (Too Many Requests)** error, Refactory will:
1. Automatically try the next provider in the chain.
2. If all providers are exhausted, it will prompt you to wait or provide a new key.
3. Logs the incident to help you tune your workflow.