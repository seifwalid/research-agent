# Apollo Organization Search (Natural Language UI)

This app lets you describe the companies you want to find in natural language. It uses Gemini to translate your request into an Apollo Organization Search query and returns results from Apollo.

- Backend: Node + Express
- LLM: Gemini (configurable via `GEMINI_MODEL`)
- Data: Apollo Organization Search API (docs: https://docs.apollo.io/reference/organization-search)

## Setup

1) Install dependencies

```bash
npm install
```

2) Configure environment variables (create a `.env` file in project root):

```
APOLLO_API_KEY=your_apollo_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-pro
PORT=3000
```

3) Start the server

```bash
npm start
```

Open http://localhost:3000 and try: "Find Series B fintech companies in London with 50–200 employees".

## Notes

- Calling Apollo consumes credits and requires a paid Apollo plan. See their limits in the docs: https://docs.apollo.io/reference/organization-search
- The server keeps API keys on the backend and uses a fallback query if a structured filter is rejected by Apollo.
- You can tune the Gemini prompt and supported fields in `server.js`.

## Security

- Do not expose your Apollo or Gemini keys to the browser. This app keeps them server-side.
- Consider additional rate limiting, request validation, and logging for production use.
