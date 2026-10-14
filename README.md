# AWS Obsidian Agent

An Obsidian plugin that gives you a conversational agent you can **talk with**, speaking responses aloud through **Amazon Polly**. It switches between **Português (pt-BR)** and **English (en-US)** on the fly.

## Features

- Chat panel in the right sidebar (ribbon icon or command palette).
- Text-to-speech replies via Amazon Polly (neural or standard engine).
- One-click / one-command language switch between `pt-BR` and `en-US`, which also swaps the Polly voice.
- Per-language voice selection.
- Credentials from your ambient AWS profile/environment, or entered manually.

## Requirements

- Obsidian 1.4.0+ (desktop only — uses the AWS SDK).
- AWS credentials with permission for `polly:SynthesizeSpeech`.

## Build

```bash
npm install
npm run build     # produces main.js
# or during development:
npm run dev       # watch mode
```

## Install into a vault

Copy `manifest.json`, `main.js`, and `styles.css` into:

```
<your-vault>/.obsidian/plugins/aws-obsidian-agent/
```

Then enable **AWS Obsidian Agent** in Settings → Community plugins.

## Usage

1. Open the agent with the ribbon **bot** icon or the command **Open AWS Agent**.
2. Type a message and press Enter.
3. The agent replies in the active language and speaks it with Polly.
4. Switch language with the dropdown in the panel header, or the command **Toggle agent language (pt-BR / en-US)**.

## Commands

- **Open AWS Agent**
- **Toggle agent language (pt-BR / en-US)**
- **Stop agent audio**

## AWS setup

The plugin needs `polly:SynthesizeSpeech`. Minimal IAM policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "polly:SynthesizeSpeech", "Resource": "*" }
  ]
}
```

By default the plugin uses ambient credentials (your AWS profile / environment). You can disable that in settings and enter an access key, secret, and optional session token instead.

## Roadmap

The agent currently uses localized rule-based replies. The `Agent.respond()` method in `agent.ts` is a single seam designed to be replaced with a real LLM backend (e.g., Amazon Bedrock) without touching the UI or TTS layers.

## License

MIT
