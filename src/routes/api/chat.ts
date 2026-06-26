import { createFileRoute } from "@tanstack/react-router";
import { convertToModelMessages, streamText, stepCountIs, tool, type UIMessage } from "ai";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import type { Database } from "@/integrations/supabase/types";

const SYSTEM_PROMPT = `You are a helpful, friendly AI assistant. Today's date is ${new Date().toISOString().slice(0, 10)}.
Format responses with markdown. Use fenced code blocks with language hints. Be concise but thorough.
You have a web_search tool powered by Firecrawl. Use it whenever the user asks about current events, recent news, today's date-sensitive info, prices, scores, weather, or anything that may have changed after your training cutoff. Always cite sources with markdown links.`;

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
                  "Search the live web for current/recent information. Returns top results with title, url, and snippet.",
                inputSchema: z.object({
                  query: z.string().describe("Search query"),
                  limit: z.number().int().min(1).max(10).optional().describe("Max results (default 5)"),
                }),
                execute: async ({ query, limit }) => {
                  try {
                    const res = await fetch("https://api.firecrawl.dev/v2/search", {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({ query, limit: limit ?? 5 }),
                    });
                    if (!res.ok) {
                      return { error: `Search failed: ${res.status} ${await res.text()}` };
                    }
                    const json = (await res.json()) as {
                      data?: { web?: Array<{ title?: string; url?: string; description?: string }> } | Array<{ title?: string; url?: string; description?: string }>;
                    };
                    const raw = Array.isArray(json.data) ? json.data : json.data?.web ?? [];
                    return {
                      results: raw.slice(0, limit ?? 5).map((r) => ({
                        title: r.title,
                        url: r.url,
                        snippet: r.description,
                      })),
                    };
                  } catch (e) {
                    return { error: e instanceof Error ? e.message : "Search failed" };
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
