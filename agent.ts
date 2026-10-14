import { AgentLanguage } from "./settings";

export interface AgentReply {
	text: string;
	lang: AgentLanguage;
}

/**
 * A simple, localized rule-based agent. It responds in the active language
 * and exposes a single `respond` seam so a real LLM backend can be dropped
 * in later without touching the UI or TTS layers.
 */
export class Agent {
	constructor(private lang: AgentLanguage) {}

	setLanguage(lang: AgentLanguage): void {
		this.lang = lang;
	}

	getLanguage(): AgentLanguage {
		return this.lang;
	}

	greeting(): AgentReply {
		const text =
			this.lang === "pt-BR"
				? "Olá! Eu sou o seu agente. Pode falar comigo e eu respondo em voz alta."
				: "Hi! I'm your agent. Talk to me and I'll answer out loud.";
		return { text, lang: this.lang };
	}

	/**
	 * Produce a reply to the user's message in the active language.
	 * Replace the body of this method with an LLM call to upgrade the agent.
	 */
	async respond(message: string): Promise<AgentReply> {
		const text = this.ruleBasedReply(message.trim());
		return { text, lang: this.lang };
	}

	private ruleBasedReply(msg: string): string {
		const lower = msg.toLowerCase();
		const pt = this.lang === "pt-BR";

		if (!msg) {
			return pt ? "Diga alguma coisa e eu respondo." : "Say something and I'll respond.";
		}

		if (/\b(oi|ol[aá]|hello|hi|hey)\b/.test(lower)) {
			return pt ? "Olá! Como posso ajudar você hoje?" : "Hello! How can I help you today?";
		}

		if (/\b(obrigad|thanks|thank you)\b/.test(lower)) {
			return pt ? "De nada! Precisa de mais alguma coisa?" : "You're welcome! Anything else?";
		}

		if (/\b(tchau|bye|goodbye|adeus)\b/.test(lower)) {
			return pt ? "Até logo! Foi bom conversar com você." : "Goodbye! It was nice talking with you.";
		}

		if (/\b(hora|horas|time)\b/.test(lower)) {
			const now = new Date().toLocaleTimeString(pt ? "pt-BR" : "en-US");
			return pt ? `Agora são ${now}.` : `It's currently ${now}.`;
		}

		if (/\b(nome|name|quem [eé] voc[eê]|who are you)\b/.test(lower)) {
			return pt
				? "Eu sou o agente do AWS Obsidian Agent, com voz pela Amazon Polly."
				: "I'm the AWS Obsidian Agent, speaking through Amazon Polly.";
		}

		if (/\?$/.test(msg)) {
			return pt
				? `Boa pergunta sobre "${msg}". Ainda sou um agente simples, mas posso falar em voz alta.`
				: `Good question about "${msg}". I'm a simple agent for now, but I can speak out loud.`;
		}

		// Default: acknowledge and echo meaningfully.
		return pt
			? `Você disse: "${msg}". Entendi! Em breve terei respostas mais inteligentes.`
			: `You said: "${msg}". Got it! Smarter answers are coming soon.`;
	}
}
