# Transcript Mind Map

Minimal app that uses a local Ollama model to extract a typed mind‑map graph from a transcript and renders it with an editable D3.js force layout.

## Requirements

- Node.js 18+
- Ollama running locally

## Run

1. Install dependencies:
   - `npm install`
2. Start the server:
   - `npm start`
3. Open http://localhost:3000

## Environment

- `OLLAMA_URL` (default: http://localhost:11434)
- `OLLAMA_MODEL` (default: llama3.2:3b)
- `OLLAMA_TIMEOUT_MS` (default: 20000)
- `OLLAMA_RETRIES` (default: 1)
- `OLLAMA_RETRY_BACKOFF_MS` (default: 500)
- `TRANSCRIPT_CHUNK_SIZE` (default: 3500)
- `NODE_ENV` (default: development)

## Usage

- Paste transcript → Generate Mind Map.
- Click a node to select.
- Double‑click a node to edit its label.
- Add nodes and edges with the controls.
- Export JSON to save the current graph.
