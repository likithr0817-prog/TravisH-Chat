import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, RefreshCcw, Square, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { Markdown } from "./Markdown";
import { toast } from "sonner";
import { updateConversation } from "@/lib/chat-db";

const MODELS = [
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "openai/gpt-5", label: "GPT-5" },
  { id: "openai/gpt-5-mini", label: "GPT-5 mini" },
];

type Props = {
  conversationId: string;
  initialMessages: UIMessage[];
  initialModel: string;
  initialTitle: string;
  onTitled?: () => void;
};

export function ChatWindow({
  conversationId,
  initialMessages,
  initialModel,
  initialTitle,
  onTitled,
}: Props) {
  const [model, setModel] = useState(initialModel);
  const [input, setInput] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const titleSetRef = useRef(initialTitle !== "New chat");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setToken(data.session?.access_token ?? null));
  }, []);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        headers: () => ({
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        }),
        body: () => ({ conversationId, model }),
      }),
    [token, conversationId, model],
  );

  const { messages, sendMessage, status, stop, regenerate, setMessages } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
    onError: (e) => toast.error(e.message || "Something went wrong"),
  });

  useEffect(() => {
    setMessages(initialMessages);
  }, [conversationId, initialMessages, setMessages]);

  // Auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [conversationId, status]);

  // Auto-title once first assistant message arrives
  useEffect(() => {
    if (titleSetRef.current) return;
    const firstUser = messages.find((m) => m.role === "user");
    const firstAssistant = messages.find((m) => m.role === "assistant");
    if (firstUser && firstAssistant && status === "ready") {
      const text =
        firstUser.parts.map((p) => (p.type === "text" ? p.text : "")).join("").slice(0, 60) ||
        "New chat";
      titleSetRef.current = true;
      updateConversation(conversationId, { title: text }).then(() => onTitled?.());
    }
  }, [messages, status, conversationId, onTitled]);

  const isBusy = status === "submitted" || status === "streaming";

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || isBusy || !token) return;
    setInput("");
    await sendMessage({ text });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium truncate">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="truncate">{initialTitle}</span>
        </div>
        <Select
          value={model}
          onValueChange={(v) => {
            setModel(v);
            updateConversation(conversationId, { model: v });
          }}
        >
          <SelectTrigger className="w-[180px] h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 space-y-6">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center text-center py-24 gap-3">
              <div className="h-12 w-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
                <Sparkles className="h-6 w-6" />
              </div>
              <h1 className="text-2xl font-semibold">How can I help today?</h1>
              <p className="text-sm text-muted-foreground max-w-md">
                Ask anything. Code, writing, ideas, analysis — start with a question or pick a prompt.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4 w-full max-w-xl">
                {[
                  "Explain quantum entanglement simply",
                  "Write a SQL query for top customers",
                  "Draft a polite follow-up email",
                  "Plan a 3-day Lisbon itinerary",
                ].map((p) => (
                  <button
                    key={p}
                    onClick={() => setInput(p)}
                    className="rounded-lg border border-border p-3 text-sm text-left hover:bg-accent transition-colors"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => {
            const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
            const isUser = m.role === "user";
            return (
              <div key={m.id} className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
                {!isUser && (
                  <div className="h-8 w-8 shrink-0 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">
                    AI
                  </div>
                )}
                <div
                  className={`max-w-[85%] ${
                    isUser
                      ? "rounded-2xl bg-primary text-primary-foreground px-4 py-2.5"
                      : "text-foreground"
                  }`}
                >
                  {isUser ? (
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
                  ) : (
                    <Markdown>{text || "…"}</Markdown>
                  )}
                </div>
              </div>
            );
          })}

          {status === "submitted" && (
            <div className="flex gap-3">
              <div className="h-8 w-8 shrink-0 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">
                AI
              </div>
              <div className="flex items-center gap-1 pt-2">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border bg-background px-4 py-3">
        <form
          onSubmit={handleSubmit}
          className="mx-auto max-w-3xl relative rounded-2xl border border-border bg-card shadow-sm focus-within:ring-2 focus-within:ring-ring transition"
        >
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Message AI…"
            rows={1}
            className="resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 px-4 py-3 pr-24 min-h-[52px] max-h-48"
          />
          <div className="absolute right-2 bottom-2 flex items-center gap-1">
            {messages.length > 0 && !isBusy && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                onClick={() => regenerate()}
                aria-label="Regenerate"
              >
                <RefreshCcw className="h-4 w-4" />
              </Button>
            )}
            {isBusy ? (
              <Button type="button" size="icon" onClick={stop} className="h-8 w-8" aria-label="Stop">
                <Square className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                disabled={!input.trim() || !token}
                className="h-8 w-8"
                aria-label="Send"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
        </form>
        <p className="mx-auto max-w-3xl text-center text-[10px] text-muted-foreground mt-2">
          AI responses may be inaccurate. Verify important information.
        </p>
      </div>
    </div>
  );
}
