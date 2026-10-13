// Where this installation runs, so privacy wording is true in both setups. Set at build time:
// NEXT_PUBLIC_ELEVATE_HOSTED=1 for the cloud deployment (render.yaml); unset for a local install.
export const HOSTED = process.env.NEXT_PUBLIC_ELEVATE_HOSTED === "1";

/** Name of the AI provider, e.g. "Groq" (hosted) — shown in privacy notices. */
export const AI_PROVIDER = process.env.NEXT_PUBLIC_ELEVATE_AI_PROVIDER || "Groq";

/** "the local model" locally, "the AI model" when hosted. */
export const MODEL = HOSTED ? "the AI model" : "the local model";

export const DATA_PROMISE = HOSTED
  ? "Your data is stored privately in your account. You can export or delete it at any time."
  : "Your data stays on this machine. You can export or delete it at any time.";

export const AI_NOTICE = HOSTED
  ? `AI analysis is processed by ${AI_PROVIDER}, which states it does not train on this data. Nothing is shared with employers.`
  : "Nothing is sent to external AI services.";
