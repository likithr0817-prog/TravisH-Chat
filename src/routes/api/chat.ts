import { createFileRoute } from "@tanstack/react-router";
import { convertToModelMessages, streamText, stepCountIs, tool, type UIMessage } from "ai";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import type { Database } from "@/integrations/supabase/types";

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
- When you do search: ONE focused query, limit 5. Only call fetch_url if snippets are insufficient, and on at most 1 page. Then answer immediately with brief inline source links.
- Never search for simple definitions, code help, math, or evergreen knowledge — it just slows the response.
- Format with markdown. Be concise and structured. Use fenced code blocks with language hints.
- If you don't know and can't verify, say so briefly rather than guessing.`;


type Body = {
  messages?: UIMessage[];
  conversationId?: string;
  model?: string;
};

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

        // Auth-scoped client (RLS applies)
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
        const model = body.model || "google/gemini-3-flash-preview";

        if (!conversationId) return new Response("conversationId required", { status: 400 });

        // Verify conversation belongs to user
        const { data: conv, error: convErr } = await supabase
          .from("conversations")
          .select("id")
          .eq("id", conversationId)
          .maybeSingle();
        if (convErr || !conv) return new Response("Forbidden", { status: 403 });

        // Persist latest user message if it isn't saved yet
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        if (lastUser) {
          const { data: existing } = await supabase
            .from("messages")
            .select("id")
            .eq("conversation_id", conversationId)
            .eq("role", "user")
            .order("created_at", { ascending: false })
            .limit(1);
          const exists = existing?.[0];
          // dedupe by content text
          const lastText = lastUser.parts
            .map((p) => (p.type === "text" ? p.text : ""))
            .join("");
          if (!exists || !lastText) {
            await supabase.from("messages").insert({
              conversation_id: conversationId,
              user_id: userId,
              role: "user",
              parts: lastUser.parts as never,
            });
          } else {
            // Check if it's the same message
            const { data: existRow } = await supabase
              .from("messages")
              .select("parts")
              .eq("id", exists.id)
              .single();
            const existText =
              ((existRow?.parts as { type: string; text?: string }[] | null) || [])
                .map((p) => (p.type === "text" ? p.text ?? "" : ""))
                .join("");
            if (existText !== lastText) {
              await supabase.from("messages").insert({
                conversation_id: conversationId,
                user_id: userId,
                role: "user",
                parts: lastUser.parts as never,
              });
            }
          }
        }

        const gateway = createLovableAiGatewayProvider(LOVABLE_API_KEY);
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
                    // Cap content to keep tokens reasonable
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

        const result = streamText({
          model: gateway(model),
          system: SYSTEM_PROMPT,
          messages: await convertToModelMessages(messages),
          tools,
          stopWhen: stepCountIs(50),
        });


        return result.toUIMessageStreamResponse({
          originalMessages: messages,
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
