import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Mic, MicOff, Paperclip, RefreshCcw, Square, Sparkles, X, Code2, Mail, Map, Lightbulb } from "lucide-react";
import logo from "@/assets/logo.png";
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
import { Sources, SearchingIndicator } from "./Sources";
import { toast } from "sonner";
import { updateConversation } from "@/lib/chat-db";

const MODELS = [
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash (newest)" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (newest)" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash (newest)" },
  { id: "openai/gpt-5.5", label: "GPT-5.5 (newest)" },
  { id: "openai/gpt-5.5-pro", label: "GPT-5.5 Pro (newest)" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "openai/gpt-5", label: "GPT-5" },
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
  const [attachments, setAttachments] = useState<{ name: string; text: string }[]>([]);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleSetRef = useRef(initialTitle !== "New chat");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setToken(data.session?.access_token ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setToken(session?.access_token ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        headers: async (): Promise<Record<string, string>> => {
          const { data } = await supabase.auth.getSession();
          const t = data.session?.access_token;
          return t ? { Authorization: `Bearer ${t}` } : {};
        },
        body: () => ({ conversationId, model }),
      }),
    [conversationId, model],
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
    if ((!text && attachments.length === 0) || isBusy || !token) return;
    let full = text;
    if (attachments.length) {
      const blocks = attachments
        .map((a) => `\n\n[Attached file: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``)
        .join("");
      full = `${text}${blocks}`;
    }
    setInput("");
    setAttachments([]);
    await sendMessage({ text: full });
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const next: { name: string; text: string }[] = [];
    for (const f of Array.from(files)) {
      if (f.size > 2 * 1024 * 1024) {
        toast.error(`${f.name} is too large (max 2MB)`);
        continue;
      }
      if (f.type.startsWith("image/")) {
        toast.message(`${f.name} attached as reference (vision parsing not enabled)`);
        next.push({ name: f.name, text: `<image: ${f.name}, ${Math.round(f.size / 1024)}KB>` });
        continue;
      }
      try {
        const text = await f.text();
        next.push({ name: f.name, text: text.slice(0, 50000) });
      } catch {
        toast.error(`Failed to read ${f.name}`);
      }
    }
    setAttachments((prev) => [...prev, ...next]);
  };

  const toggleVoice = () => {
    const SR =
      (typeof window !== "undefined" &&
        ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) ||
      null;
    if (!SR) {
      toast.error("Voice input not supported in this browser");
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    let finalText = "";
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setInput((prev) => {
        const base = prev.replace(/\s*\[\.\.\.\].*$/, "");
        return (base + " " + finalText + (interim ? ` [...]${interim}` : "")).trimStart();
      });
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => {
      setListening(false);
      setInput((prev) => prev.replace(/\s*\[\.\.\.\].*$/, "").trimEnd());
    };
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border/60 px-4 py-2.5 backdrop-blur-sm bg-background/70 sticky top-0 z-10">
        <div className="flex items-center gap-2 text-sm font-medium truncate min-w-0">
          <img src={logo} alt="" width={20} height={20} className="h-5 w-5 shrink-0" />
          <span className="truncate">{initialTitle}</span>
        </div>
        <Select
          value={model}
          onValueChange={(v) => {
            setModel(v);
            updateConversation(conversationId, { model: v });
          }}
        >
          <SelectTrigger className="w-[180px] h-8 text-xs rounded-full">
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
            <div className="flex flex-col items-center justify-center text-center py-16 sm:py-24 gap-4 animate-fade-in">
              <div className="relative">
                <div className="absolute inset-0 blur-2xl bg-brand-gradient opacity-40 rounded-full" />
                <img src={logo} alt="JABBI AI" width={72} height={72} className="relative h-18 w-18" />
              </div>
              <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
                Hi, I'm <span className="text-brand-gradient">JABBI AI</span>
              </h1>
              <p className="text-sm text-muted-foreground max-w-md">
                Your AI companion for ideas, code, writing, and research — with live web search built in.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4 w-full max-w-xl">
                {[
                  { icon: Lightbulb, text: "Explain quantum entanglement simply" },
                  { icon: Code2, text: "Write a SQL query for top customers" },
                  { icon: Mail, text: "Draft a polite follow-up email" },
                  { icon: Map, text: "Plan a 3-day Lisbon itinerary" },
                ].map(({ icon: Icon, text }) => (
                  <button
                    key={text}
                    onClick={() => setInput(text)}
                    className="group rounded-xl border border-border/60 bg-card/50 p-3 text-sm text-left hover:border-primary/40 hover:bg-accent/60 hover:-translate-y-0.5 transition-all duration-200 flex items-start gap-2.5"
                  >
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-gradient/10 text-primary group-hover:bg-brand-gradient group-hover:text-white transition-colors">
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="leading-snug">{text}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, idx) => {
            const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
            const isUser = m.role === "user";
            const isLast = idx === messages.length - 1;
            const isStreaming = !isUser && isLast && status === "streaming";
            return (
              <div key={m.id} className={`flex gap-3 animate-fade-in ${isUser ? "justify-end" : "justify-start"}`}>
                {!isUser && (
                  <div className="h-8 w-8 shrink-0 rounded-full bg-brand-gradient flex items-center justify-center shadow-brand">
                    <Sparkles className="h-4 w-4 text-white" />
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
                    <div className="relative">
                      <Markdown>{text || "…"}</Markdown>
                      {isStreaming && <span className="stream-caret" aria-hidden="true" />}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {status === "submitted" && (
            <div className="flex gap-3 animate-fade-in">
              <div className="h-8 w-8 shrink-0 rounded-full bg-brand-gradient flex items-center justify-center shadow-brand">
                <Sparkles className="h-4 w-4 text-white" />
              </div>
              <div className="flex-1 max-w-[85%] space-y-2.5 pt-1">
                <p className="text-sm text-shimmer font-medium">Thinking…</p>
                <div className="space-y-2">
                  <div className="h-3 rounded-md bg-shimmer w-[92%]" />
                  <div className="h-3 rounded-md bg-shimmer w-[78%]" />
                  <div className="h-3 rounded-md bg-shimmer w-[60%]" />
                </div>
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
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 p-2 pb-0">
              {attachments.map((a, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
                >
                  <Paperclip className="h-3 w-3" />
                  <span className="max-w-[160px] truncate">{a.name}</span>
                  <button
                    type="button"
                    onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                    className="ml-1 text-muted-foreground hover:text-foreground"
                    aria-label="Remove attachment"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
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
            className="resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 px-4 py-3 pl-20 pr-24 min-h-[52px] max-h-48"
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.json,.csv,.log,text/*,image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <div className="absolute left-2 bottom-2 flex items-center gap-1">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach file"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant={listening ? "default" : "ghost"}
              className="h-8 w-8"
              onClick={toggleVoice}
              aria-label="Voice input"
            >
              {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
          </div>
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
                disabled={(!input.trim() && attachments.length === 0) || !token}
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
