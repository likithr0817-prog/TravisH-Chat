import { createFileRoute } from "@tanstack/react-router";
import { convertToModelMessages, streamText, stepCountIs, tool, generateText, type UIMessage, type ModelMessage } from "ai";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import type { Database } from "@/integrations/supabase/types";

const SUPPORTED_MODELS = new Set([
  "google/gemini-3-flash-preview",
  "google/gemini-2.5-pro",
  "openai/gpt-5",
]);

const SUMMARY_MODEL = "google/gemini-3.6-flash";
const MAX_OUTPUT_TOKENS = 8192;

// Rough char->token estimate (1 token ~ 4 chars)
const CHARS_PER_TOKEN = 4;
// Send at most ~80k tokens of raw history; summarize the rest
const HISTORY_TOKEN_BUDGET = 80_000;
const KEEP_RECENT_MESSAGES = 20;
// Per-attachment budget before we summarize it server-side
const ATTACHMENT_CHAR_LIMIT = 15_000 * CHARS_PER_TOKEN;

const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_HUMAN = new Date().toLocaleDateString("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});

const SYSTEM_PROMPT = `You are JABBI AI — a fast, accurate, helpful assistant.

CURRENT DATE: ${TODAY_HUMAN} (${TODAY}).

SPEED & ACCURACY:
- Answer directly from your own knowledge for general, conceptual, coding, math, writing, or explanation tasks. Do NOT search the web for these.
- Only call web_search when the question is clearly time-sensitive or about facts likely to have changed after training: today's news, current prices/scores/weather, latest releases, "who is currently…", recent events.
- When you do search: ONE focused query, limit 5. Only call fetch_url if snippets are insufficient, and on at most 1 page. Then answer immediately.
- Never search for simple definitions, code help, math, or evergreen knowledge — it just slows the response.
- Format with markdown. Be concise and structured. Use fenced code blocks with language hints.
- If you don't know and can't verify, say so briefly rather than guessing.

WHEN YOU USE WEB SEARCH:
- Do NOT include a bulky "Sources" markdown list — the UI renders a rich Sources panel automatically from your tool calls.
- Cite facts inline with [1], [2] matching the order of search results you used.
- End the answer with a short italic confidence note on its own line, e.g.:
  *Confidence: high — multiple recent sources agree (as of ${TODAY}).*
  *Confidence: medium — based on one recent source; details may shift.*
  *Confidence: low — limited or conflicting data; please verify.*`;


type Body = {
  messages?: UIMessage[];
  conversationId?: string;
  model?: string;
};

function clientSafeAiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b402\b|credit|billing|payment/i.test(message)) {
    return "AI credits are exhausted for this workspace. Add credits, then try again.";
  }
  if (/\b429\b|rate limit|too many requests/i.test(message)) {
    return "The AI is rate limited right now. Please wait a moment and try again.";
  }
  console.error("AI stream failed", error);
  return "The AI response failed before it could finish. Please try again.";
}

function messageText(m: UIMessage): string {
  return m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

function approxTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function totalTokens(messages: UIMessage[]): number {
  return messages.reduce((n, m) => n + approxTokens(messageText(m)), 0);
}

// Summarize a chunk of text with the cheap model. Returns null on failure.
async function summarize(
  gateway: ReturnType<typeof createLovableAiGatewayProvider>,
  text: string,
  purpose: "history" | "attachment",
  priorSummary?: string,
): Promise<string | null> {
  try {
    const system =
      purpose === "history"
        ? "You compress chat history. Produce a dense, factual bullet summary preserving user goals, decisions, names, code identifiers, numbers, and any commitments the assistant made. No preamble."
        : "You compress a long attached document. Produce a dense bullet summary preserving key facts, numbers, entities, and structure. No preamble.";
    const prompt = priorSummary
      ? `PRIOR SUMMARY:\n${priorSummary}\n\nNEW CONTENT TO FOLD IN:\n${text}\n\nReturn ONE updated combined summary.`
      : text;
    const { text: out } = await generateText({
      model: gateway(SUMMARY_MODEL),
      system,
      prompt,
      maxOutputTokens: 1200,
    });
    return out.trim() || null;
  } catch (e) {
    console.error("summary failed", e);
    return null;
  }
}

// Rewrite the last user message so any oversized attachment code-fence
// blocks are replaced by a compact server-generated summary.
async function compressAttachments(
  gateway: ReturnType<typeof createLovableAiGatewayProvider>,
  messages: UIMessage[],
): Promise<UIMessage[]> {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  if (last.role !== "user") return messages;
  const text = messageText(last);
  if (text.length < ATTACHMENT_CHAR_LIMIT) return messages;

  // Match blocks like: [Attached file: name]\n```\n...content...\n```
  const re = /\[Attached file: ([^\]]+)\]\n```[a-zA-Z]*\n([\s\S]*?)\n```/g;
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) return messages;

  let rewritten = text;
  for (const m of matches) {
    const [full, name, content] = m;
    if (content.length < ATTACHMENT_CHAR_LIMIT) continue;
    const summary = await summarize(gateway, content, "attachment");
    if (!summary) continue;
    rewritten = rewritten.replace(
      full,
      `[Attached file: ${name} — summarized from ${content.length} chars]\n${summary}`,
    );
  }
  if (rewritten === text) return messages;
  const newLast: UIMessage = {
    ...last,
    parts: [{ type: "text", text: rewritten }],
  };
  return [...messages.slice(0, lastIdx), newLast];
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authHeader = request.headers.get("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response("Unauthorized", { status: 401 });
        }
        const token = authHeader.slice(7);

        const SUPABASE_URL = process.env.SUPABASE_URL!;
        const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;
        const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
        if (!LOVABLE_API_KEY) return new Response("AI not configured", { status: 500 });

        const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          global: {
            fetch: (input, init) => {
              const headers = new Headers(init?.headers);
              headers.set("apikey", SUPABASE_PUBLISHABLE_KEY);
              headers.set("Authorization", `Bearer ${token}`);
              return fetch(input, { ...init, headers });
            },
          },
          auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
        });


        const { data: userData, error: userErr } = await supabase.auth.getUser(token);
        if (userErr || !userData.user) return new Response("Unauthorized", { status: 401 });
        const userId = userData.user.id;

        const body = (await request.json()) as Body;
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const conversationId = body.conversationId;
        const requestedModel = body.model || "google/gemini-3-flash-preview";
        const model = SUPPORTED_MODELS.has(requestedModel)
          ? requestedModel
          : "google/gemini-3-flash-preview";

        if (!conversationId) return new Response("conversationId required", { status: 400 });

        // Verify conversation belongs to user
        const { data: conv, error: convErr } = await supabase
          .from("conversations")
          .select("id, summary, summary_up_to_message_id")
          .eq("id", conversationId)
          .maybeSingle();
        if (convErr || !conv) return new Response("Forbidden", { status: 403 });

        // Persist latest user message if it isn't saved yet
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        let lastUserDbId: string | null = null;
        if (lastUser) {
          const lastText = messageText(lastUser);
          const { data: existing } = await supabase
            .from("messages")
            .select("id, parts")
            .eq("conversation_id", conversationId)
            .eq("role", "user")
            .order("created_at", { ascending: false })
            .limit(1);
          const existRow = existing?.[0];
          const existText =
            ((existRow?.parts as { type: string; text?: string }[] | null) || [])
              .map((p) => (p.type === "text" ? p.text ?? "" : ""))
              .join("");
          if (!existRow || existText !== lastText) {
            const { data: inserted } = await supabase
              .from("messages")
              .insert({
                conversation_id: conversationId,
                user_id: userId,
                role: "user",
                parts: lastUser.parts as never,
              })
              .select("id")
              .single();
            lastUserDbId = inserted?.id ?? null;
          } else {
            lastUserDbId = existRow.id;
          }
        }

        const gateway = createLovableAiGatewayProvider(LOVABLE_API_KEY);

        // 1) Compress oversized attachments in the last user message
        let workingMessages = await compressAttachments(gateway, messages);

        // 2) Sliding-window + running summary for very long threads
        let historySummary = conv.summary ?? null;
        if (totalTokens(workingMessages) > HISTORY_TOKEN_BUDGET && workingMessages.length > KEEP_RECENT_MESSAGES) {
          const oldMessages = workingMessages.slice(0, workingMessages.length - KEEP_RECENT_MESSAGES);
          const recent = workingMessages.slice(-KEEP_RECENT_MESSAGES);
          const oldText = oldMessages
            .map((m) => `${m.role.toUpperCase()}: ${messageText(m)}`)
            .join("\n\n");
          const updated = await summarize(gateway, oldText, "history", historySummary ?? undefined);
          if (updated) {
            historySummary = updated;
            // Persist so future turns skip re-summarizing older messages
            const lastKeptId =
              (oldMessages[oldMessages.length - 1] as UIMessage & { id?: string }).id ?? null;
            await supabase
              .from("conversations")
              .update({
                summary: historySummary,
                summary_up_to_message_id: lastKeptId,
              })
              .eq("id", conversationId);
            workingMessages = recent;
          }
        }

        const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
        const tools = FIRECRAWL_API_KEY
          ? {
              web_search: tool({
                description:
                  "Search the live web for current/recent information via Firecrawl. Use for anything time-sensitive, news, prices, recent releases, or facts that may have changed. Returns top results with title, url, snippet, and publishedDate when available.",
                inputSchema: z.object({
                  query: z.string().describe("Focused search query. Include the year or 'today' for time-sensitive topics."),
                  limit: z.number().int().min(1).max(8).optional().describe("Max results (default 5)"),
                  freshness: z
                    .enum(["day", "week", "month", "year", "any"])
                    .optional()
                    .describe("Time filter for results. Use 'day' or 'week' for news."),
                }),
                execute: async ({ query, limit, freshness }) => {
                  try {
                    const tbsMap: Record<string, string> = {
                      day: "qdr:d",
                      week: "qdr:w",
                      month: "qdr:m",
                      year: "qdr:y",
                    };
                    const body: Record<string, unknown> = {
                      query,
                      limit: limit ?? 5,
                    };
                    if (freshness && freshness !== "any" && tbsMap[freshness]) {
                      body.tbs = tbsMap[freshness];
                    }
                    const res = await fetch("https://api.firecrawl.dev/v2/search", {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify(body),
                    });
                    if (!res.ok) {
                      return { error: `Search failed: ${res.status} ${await res.text()}` };
                    }
                    const json = (await res.json()) as {
                      data?:
                        | { web?: Array<{ title?: string; url?: string; description?: string; publishedDate?: string; date?: string }> }
                        | Array<{ title?: string; url?: string; description?: string; publishedDate?: string; date?: string }>;
                    };
                    const raw = Array.isArray(json.data) ? json.data : json.data?.web ?? [];
                    return {
                      query,
                      retrievedAt: new Date().toISOString(),
                      results: raw.slice(0, limit ?? 5).map((r) => ({
                        title: r.title,
                        url: r.url,
                        snippet: r.description,
                        publishedDate: r.publishedDate ?? r.date,
                      })),
                    };
                  } catch (e) {
                    return { error: e instanceof Error ? e.message : "Search failed" };
                  }
                },
              }),
              fetch_url: tool({
                description:
                  "Fetch and read the full cleaned content of a specific URL via Firecrawl. Call this on the most relevant URLs returned by web_search to verify facts before answering. Returns markdown of the page.",
                inputSchema: z.object({
                  url: z.string().url().describe("The exact URL to read"),
                }),
                execute: async ({ url }) => {
                  try {
                    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({
                        url,
                        formats: ["markdown"],
                        onlyMainContent: true,
                      }),
                    });
                    if (!res.ok) {
                      return { error: `Fetch failed: ${res.status} ${await res.text()}` };
                    }
                    const json = (await res.json()) as {
                      data?: { markdown?: string; metadata?: { title?: string; sourceURL?: string; publishedDate?: string } };
                      markdown?: string;
                      metadata?: { title?: string; sourceURL?: string; publishedDate?: string };
                    };
                    const md = json.data?.markdown ?? json.markdown ?? "";
                    const meta = json.data?.metadata ?? json.metadata ?? {};
                    const capped = md.length > 6000 ? md.slice(0, 6000) + "\n\n…[truncated]" : md;
                    return {
                      url,
                      title: meta.title,
                      publishedDate: meta.publishedDate,
                      retrievedAt: new Date().toISOString(),
                      content: capped,
                    };
                  } catch (e) {
                    return { error: e instanceof Error ? e.message : "Fetch failed" };
                  }
                },
              }),
            }
          : undefined;

        const modelMessages: ModelMessage[] = await convertToModelMessages(workingMessages);
        const systemPrompt = historySummary
          ? `${SYSTEM_PROMPT}\n\nCONVERSATION SUMMARY SO FAR (older messages, compressed for context):\n${historySummary}`
          : SYSTEM_PROMPT;

        const result = streamText({
          model: gateway(model),
          system: systemPrompt,
          messages: modelMessages,
          tools,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          stopWhen: stepCountIs(6),
          onError: ({ error }) => {
            console.error("AI stream failed", error);
          },
        });


        return result.toUIMessageStreamResponse({
          originalMessages: messages,
          onError: clientSafeAiError,
          onFinish: async ({ messages: finalMessages }) => {
            const assistant = [...finalMessages].reverse().find((m) => m.role === "assistant");
            if (!assistant) return;
            try {
              await supabase.from("messages").insert({
                conversation_id: conversationId,
                user_id: userId,
                role: "assistant",
                parts: assistant.parts as never,
              });
            } catch (e) {
              console.error("Persist assistant failed", e);
            }
          },
        });
      },
    },
  },
});
