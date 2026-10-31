# AI chat

An Express + React app that streams replies with the Vercel AI SDK and saves conversations in durable actors.

## Run locally

Requires Bun 1.4.2+ and an OpenAI API key.

```sh
bunx durable-actors init ai-chat-example --template ai-chat
cd ai-chat-example
bun install
cp .env.example .env
```

Already in the example directory? Start at `bun install`. Add `OPENAI_API_KEY` to `.env`, then start the actors:

```sh
bun run dev:actors
```

Wait for `Ready`. In another terminal in the same directory:

```sh
bun run dev
```

Open [localhost:3000](http://127.0.0.1:3000), send a message, and reload after the reply finishes. The conversation survives server restarts.

## Save the conversation

[ChatHistory](src/actors.ts) stores messages in one `@Persisted` array. The [backend](src/backend.ts) streams the model's reply, then saves the user message and completed reply together in one actor call.

Failed or interrupted attempts are not saved. The [React client](src/Chat.tsx) shows the error and uses the AI SDK's built-in retry action. Reloading restores only completed exchanges; streams are not resumed.

The lobby is shared and has no authentication. Add authentication and chat ownership checks before using it for private conversations.

## Development

Both processes read `.env`; actor state lives in `.durable-actors/`. Actor code reloads automatically; restart `bun run dev` after editing the actor class imported by the backend. For multiple examples, set distinct `PORT`, `DURABLE_ACTORS_PORT`, and matching control-plane URLs; see [Run the examples together](https://github.com/TerseAI/durable-actors/tree/main/examples#run-the-examples-together).

`bun run build` checks TypeScript and builds the frontend.
